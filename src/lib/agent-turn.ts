/**
 * AN AGENT TURN (SOPHIE-LEAD-EVENT-AGENT-1027). Owner Kevin, 2026-10-27: Sophie decides at each Lead event whether to
 * write to that lead now, later or not at all « avec toutes les infos dont elle a besoin soit en contexte soit en mode
 * agent comme sur le chat en utilisant les tools à sa disposition ».
 *
 * A writer that used to make ONE `/complete` call gets the same call as a loop with tools: the prompt it built (the
 * thread on every channel, who the person is to us, our facts, the game) is the CONTEXT; what it cannot know in advance
 * (where this person stands in THEIR own account: what they set up and chose at signup, their campaigns and whether they
 * run, their balance and billing, the step they have not taken) it READS, through tools, before answering. Each step
 * the model either asks for reads or answers in the caller's own response schema; the last step must answer.
 *
 * Why the loop lives here and not in chat-service's Copilot: the Copilot's tools act for the org that CALLS (the brand
 * writing), while this agent reads the RECIPIENT's account, and that read has a no-leak property this service already
 * owns (`figure-reader.ts`): the org a read acts in is one of the recipient's own memberships at the identity provider,
 * the read goes through the customer API as that recipient with no staff route, and every id it names was learnt from
 * an earlier read of their account. Every model call still goes through chat-service `/complete` (model resolution,
 * provider key, cost on the calling run). Read-only: no tool writes anything.
 *
 * The result keeps `/complete`'s shape (`json` = the caller's answer) so a writer's next node reads it unchanged, plus
 * `steps` (why each step read or answered) and `reads` (every read made or refused): the recorded run shows what the
 * decision was reasoned from.
 */
import {
  buildCatalogue,
  compactJson,
  gateRead,
  learnIdentifiers,
  renderCatalogue,
  type FigureReaderDeps,
  type PlannedRead,
  type ReadRecord,
  type RecipientScope,
} from "./figure-reader.js";

export const AGENT_MAX_STEPS = 4;
export const AGENT_MAX_READS_PER_STEP = 6;
/** Past this, the next step must answer: the calling `http.call` node gives up at 600 s. */
export const AGENT_DEADLINE_MS = 360_000;

export interface AgentTurnRequest {
  systemPrompt: string;
  message: string;
  /** The caller's answer schema (strict JSON Schema object). */
  responseSchema: Record<string, unknown>;
  provider: string;
  model: string;
  maxTokens?: number;
  /** The person the message goes to: their own account is the only one the tools read. */
  recipientEmail: string | null;
}

export interface AgentStep {
  step: number;
  action: "read" | "answer";
  why: string;
}

export interface AgentTurnResult {
  json: Record<string, unknown>;
  content: string;
  model: string | null;
  steps: AgentStep[];
  reads: ReadRecord[];
  recipient: { email: string | null; isMember: boolean; organizations: Array<{ orgId: string; name: string | null }> };
}

type AgentDeps = Pick<FigureReaderDeps, "loadSpec" | "resolveRecipient" | "apiGet"> & {
  complete(request: Record<string, unknown>): Promise<{ content: string; json?: Record<string, unknown>; model?: string }>;
  now?: () => number;
};

const READ_ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    orgId: { type: "string", description: "One of THEIR ORGANIZATIONS for an account read; empty for a PUBLIC route." },
    path: { type: "string", description: "The route with its {params} filled in, no query string." },
    query: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { name: { type: "string" }, value: { type: "string" } },
        required: ["name", "value"],
      },
    },
  },
  required: ["orgId", "path", "query"],
} as const;

/**
 * One READ step: the reads the model needs next, or none when it knows enough. Flat on purpose: wrapping the caller's
 * answer schema inside a "read or answer" step made GLM answer garbage on its first step (replay 2026-10-27), so the
 * answer is always its own final call, in the caller's schema, exactly as a `/complete` writer gets it.
 */
export const AGENT_READ_STEP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    why: {
      type: "string",
      description: "One sentence: what you still need to know about where they stand, and why it changes your decision or message; or, when reads is empty, what you now know that decides it.",
    },
    reads: { type: "array", items: READ_ITEM_SCHEMA, description: "The reads you need next. Empty when you know enough to decide." },
  },
  required: ["why", "reads"],
} as const;

/** The tools, explained as a strategy (what to look for and why), never as a script of reads. */
export const AGENT_TOOLS_STRATEGY = [
  "YOUR TOOLS. Before you decide, you read THIS PERSON's own account with us, exactly as they see it in their dashboard: what they set up (their brand, what it sells, who it targets, the choices they made when they signed up), their campaigns and whether each one runs, their balance and billing, and so the next step they have not taken yet. Their brands are already read for you below.",
  "Read what tells you where they stand: the next step you point them to must be one they have really not taken yet, and anything their account or the thread already says is known. Never ask them something their account or the thread already answers; build on it.",
  "The events listed with the thread are a trail of what they clicked or did, not the state of their account: before you point them to a next step (launch a campaign, add a card, set a budget, finish a setting) or decide to wait for one, read that state in their account (their campaigns and whether each runs, their billing). Skip reads only when the thread alone settles your decision.",
  "Each read names a route below, orgId one of THEIR ORGANIZATIONS, and only ids you read from their account. Read only what can change your decision or your message. A read refused or empty is a fact too: never guess what it would have said.",
  "What you read is for you: never quote ids, route names or raw values, never say you looked at their account. Say what matters to them in their words.",
].join("\n");

const READ_STEP_TASK =
  "NOW: do not write yet. Plan your reads: list the reads you need next in reads (at most " + AGENT_MAX_READS_PER_STEP + "), or leave reads empty when what you have read is enough to decide. Anything you say you need to check goes in reads now. You answer in a later call.";
const FIRST_READ_STEP_TASK =
  "This is your first look at their account: only their brands are read so far, so where they stand now (their campaigns, their billing) is not read yet. " + READ_STEP_TASK;

/** A path written with its query string (`/v1/campaigns?brandId=x`) is read as path + query; the gate still judges both. */
export function splitQuery(read: PlannedRead): PlannedRead {
  const path = String(read.path ?? "");
  const at = path.indexOf("?");
  if (at < 0) return read;
  const extra = [...new URLSearchParams(path.slice(at + 1)).entries()].map(([name, value]) => ({ name, value }));
  const query = Array.isArray(read.query) ? read.query : [];
  return { ...read, path: path.slice(0, at), query: [...query, ...extra.filter((e) => !query.some((q) => q.name === e.name))] };
}

function scopeLines(scope: RecipientScope): string[] {
  return scope.organizations.map((o) => `- orgId ${o.orgId}: ${o.name ?? "(unnamed)"}`);
}

/**
 * Runs one agent turn. A person with no account (no organization at the identity provider) has nothing to read: one
 * call, the caller's schema, no tools. Otherwise up to `AGENT_MAX_STEPS - 1` read steps (each ends when the model asks
 * no read), then ONE answer call in the caller's schema with everything read in front of it. Past the deadline the
 * reads stop and the answer is asked at once. An answer that is not JSON throws (nothing is written blind).
 */
export async function runAgentTurn(req: AgentTurnRequest, deps: AgentDeps): Promise<AgentTurnResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const email = req.recipientEmail?.trim().toLowerCase() || null;
  const scope: RecipientScope = email ? await deps.resolveRecipient(email) : { email: null, userIds: [], organizations: [] };
  const recipient = {
    email,
    isMember: scope.organizations.length > 0,
    organizations: scope.organizations.map((o) => ({ orgId: o.orgId, name: o.name })),
  };
  const maxTokens = req.maxTokens ?? 16_000;
  const answer = async (systemPrompt: string, message: string) => {
    const res = await deps.complete({
      provider: req.provider,
      model: req.model,
      systemPrompt,
      message,
      responseFormat: "json",
      responseSchema: req.responseSchema,
      maxTokens,
    });
    if (!res.json) throw new Error(`agent-turn: the model answered no JSON: ${String(res.content ?? "").slice(0, 300)}`);
    return res;
  };

  if (scope.organizations.length === 0) {
    const res = await answer(req.systemPrompt, req.message);
    return {
      json: res.json as Record<string, unknown>,
      content: res.content,
      model: res.model ?? null,
      steps: [{ step: 1, action: "answer", why: "They have no account with us: nothing to read, the thread and the facts are everything." }],
      reads: [],
      recipient,
    };
  }

  const catalogue = buildCatalogue(await deps.loadSpec());
  if (catalogue.length === 0) throw new Error("agent-turn: api-service served no readable route");
  const owned = new Set<string>();
  for (const o of scope.organizations) owned.add(o.orgId.toLowerCase());
  for (const u of scope.userIds) owned.add(u.toLowerCase());
  if (email) owned.add(email);

  const reads: ReadRecord[] = [];
  const transcript: string[] = [];
  const runRead = async (asked: PlannedRead): Promise<void> => {
    const planned = splitQuery(asked);
    const gated = gateRead(planned, catalogue, scope, owned);
    if (!gated.ok) {
      console.error(`[agent-turn] refused ${planned.path}: ${gated.reason}`);
      reads.push({ kind: "account", orgId: planned.orgId || null, target: planned.path, status: null, refused: gated.reason });
      transcript.push(`REFUSED GET ${planned.path}: ${gated.reason}`);
      return;
    }
    const identity = gated.isPublic ? null : { orgId: gated.orgId as string, userId: gated.userId as string };
    let res: { status: number; body: unknown };
    try {
      res = await deps.apiGet(gated.url, identity);
    } catch (err) {
      // A read the gateway could not serve (its 5xx, a transport failure) is recorded and shown to the model as
      // unread, never guessed: the turn goes on with what it has. The brands read before the loop still throws.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[agent-turn] read failed ${gated.url}: ${message}`);
      reads.push({ kind: gated.isPublic ? "public" : "account", orgId: gated.orgId, target: gated.url, status: null, refused: `read_failed: ${message.slice(0, 300)}` });
      transcript.push(`FAILED GET ${gated.url}: could not be read (${message.slice(0, 200)}). Not a fact about them: never guess what it holds.`);
      return;
    }
    reads.push({ kind: gated.isPublic ? "public" : "account", orgId: gated.orgId, target: gated.url, status: res.status, refused: null });
    if (res.status >= 200 && res.status < 300 && !gated.isPublic && !gated.learnsNoIds) learnIdentifiers(res.body, owned);
    transcript.push(`GET ${gated.url} -> ${res.status}\n${compactJson(res.body)}`);
  };

  // Every account starts from its brands: the first ids a read may name. Unreadable = the turn fails (redelivered).
  for (const org of scope.organizations) {
    await runRead({ orgId: org.orgId, path: "/v1/brands", query: [] });
    const last = reads[reads.length - 1];
    if (last.refused) throw new Error(`agent-turn: their account could not be read (${last.target}): ${last.refused}`);
  }

  const systemPrompt = req.systemPrompt + "\n\n" + AGENT_TOOLS_STRATEGY;
  const accountBlock = () => [
    "",
    "THEIR ORGANIZATIONS (the accounts you can read):",
    ...scopeLines(scope),
    "",
    "READS SO FAR (their own account):",
    ...(transcript.length ? transcript : ["(none)"]),
  ];
  const steps: AgentStep[] = [];

  for (let step = 1; step < AGENT_MAX_STEPS; step += 1) {
    if (now() - started > AGENT_DEADLINE_MS) {
      console.error(`[agent-turn] past ${AGENT_DEADLINE_MS} ms after ${reads.length} reads: answering now`);
      break;
    }
    const res = await deps.complete({
      provider: req.provider,
      model: req.model,
      systemPrompt,
      message: [req.message, ...accountBlock(), "", "READABLE ROUTES (* = required query parameter):", renderCatalogue(catalogue), "", step === 1 ? FIRST_READ_STEP_TASK : READ_STEP_TASK].join("\n"),
      responseFormat: "json",
      responseSchema: AGENT_READ_STEP_SCHEMA,
      maxTokens,
    });
    const out = res.json as { why?: string; reads?: PlannedRead[] } | undefined;
    if (!out || !Array.isArray(out.reads)) {
      throw new Error(`agent-turn: the model answered no read plan (step ${step}): ${String(res.content ?? "").slice(0, 300)}`);
    }
    const why = String(out.why ?? "").trim();
    steps.push({ step, action: "read", why });
    if (out.reads.length === 0) {
      console.log(`[agent-turn] step ${step}: enough read (${reads.length} reads): ${why}`);
      break;
    }
    console.log(`[agent-turn] step ${step} reads ${out.reads.length}: ${why}`);
    for (const r of out.reads.slice(0, AGENT_MAX_READS_PER_STEP)) await runRead(r);
  }

  const res = await answer(systemPrompt, [req.message, ...accountBlock(), "", "NOW: decide and answer, from the thread and what you read."].join("\n"));
  steps.push({ step: steps.length + 1, action: "answer", why: "Answered from the thread and " + reads.length + " read(s) of their account." });
  console.log(`[agent-turn] answered after ${reads.length} reads`);
  return { json: res.json as Record<string, unknown>, content: res.content, model: res.model ?? null, steps, reads, recipient };
}
