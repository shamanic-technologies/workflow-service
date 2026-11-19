/**
 * WRITER-SENDER-SPLIT-1118 (owner 2026-11-16 « a script makes ONE outcome, a writer never sends »; go 2026-11-18).
 *
 * The lead follow-up (`lead_interested/dy_follow_up_due`) served the person, read everything, WROTE the message with
 * its model and SENT it, and declared no `message_written`: its sends linked to an older, unrelated written message of
 * the lead, or to nothing (prod 2026-11-18: 341 sends in 14 days, none with a written message of its own).
 *
 * It becomes two scripts, cut from the STORED code (the source of truth) at its own flow lines, nothing rewritten:
 *
 * - `message_written/dy_follow_up_due` (the WRITER): the prompt (`step_compose`), the voice applied
 *   (`step_client_comms_voice`), the completion asked of the LLM completion Engine, and the decision read
 *   (`step_finalize`): the stored lines, verbatim, on what its sender hands it (material `follow_up_requested`, which
 *   only that sender hands). It calls no door. Made = the message as it will be sent (the stored `finalize` result of a
 *   `write`), on the lead: the runner declares it. Any other decision (later, stop, escalate, cannot_write) = no Unit,
 *   the same result handed back (`answer`).
 * - `lead_interested/dy_follow_up_due` (the SENDER, an UPGRADE): every stored line but those. It serves, reads, picks
 *   the channel, reads the voice, asks the writer, then sends, alerts the rep, sets the date and records the look,
 *   exactly as stored. When nothing is to be written (`channel_plan.skipModel`) no writer is asked, as no model was.
 *
 * Same model answer = the same doors called with the same bodies (`tests/unit/follow-up-split.test.ts`; on production's
 * recorded cases: `scripts/prove-follow-up-split.mjs`).
 */

export const FOLLOW_UP_WRITER_OUTCOME = "message_written";
export const FOLLOW_UP_SENDER_OUTCOME = "lead_interested";
export const FOLLOW_UP_DYNASTY = "dy_follow_up_due";
/** The material the sender hands its writer (everything the prompt reads); no other run holds it. */
export const FOLLOW_UP_REQUESTED = "follow_up_requested";
/** The fields of the writer's Unit a person reads (its pair proofs judge them). */
export const FOLLOW_UP_PERSON_FIELDS = ["subject", "sequence.*.bodyHtml", "whatsappBody.text", "whatsappBody.messages.*"];
export const FOLLOW_UP_WRITER_NAME = "Lead follow-up writer";
export const FOLLOW_UP_WRITER_DESCRIPTION =
  "Writes the one follow-up a lead gets when their follow-up date has passed: reads the thread, the facts and who they are to the brand as its sender hands them, decides to write, wait, stop or hand over to the team, and writes the message with the model the Rating picks.";
export const FOLLOW_UP_SENDER_DESCRIPTION =
  "Follows up each lead whose follow-up date has passed, one per run: serves them, reads their thread and the brand's facts, asks the lead follow-up writer for the message, then sends it on WhatsApp when the brand can reach them there, else by email, and always leaves their next follow-up date. Only their own no, an unsubscribe, a disqualification or a payment ends the follow-ups.";

/** The stored code's own anchors. Each must be found exactly once, else nothing is generated. */
export const FOLLOW_UP_ANCHORS = {
  runStart: "export default function run(ctx: ScriptContext): ScriptResult {\n",
  compose: "  results.compose = step_compose(",
  voiceRead: '  results.read_client_comms = callStep(ctx, "voice.read", ',
  voiceSkip: "skip: (results.compose?.skip) }, 2);",
  voiced: "  results.client_comms_voice = step_client_comms_voice(",
  draft: '  results.draft = callStep(ctx, "llm_completion", ',
  finalize: "  results.finalize = step_finalize((results.draft), (results.resolve_person), (results.channel_plan), (flow_input.campaignId));\n",
  runEnd: '  throw new Error("the run reached no end");\n}\n',
  /** After the run: the helpers that ask the LLM completion Engine (the writer's alone). */
  completionHelpers: "\n/**\n * ONE-WRITER-N-MODELS-1116: this script names no model.",
};

/**
 * The sender asks no model: the completion helpers leave with the writer. A script's materials are read off its code
 * (`readMaterials`: every `ctx.get("<outcome>")`), so a helper left behind made the sender need a completion nobody
 * hands it and no run could draw it (2026-11-19: stored v9 read `["message_written", "llm_completion"]`, put back
 * within the minute). The stored step caller still names the helper for its completion door: it stays, unreachable.
 */
const SENDER_NO_MODEL = `
/** WRITER-SENDER-SPLIT-1118: this script asks its writer, never a model. No step of its flow reaches here. */
function askCompletionData(_ctx: any, _call: Record<string, unknown>): any {
  throw new Error("this script calls no model: its writer does");
}
`;

/** What the prompt lines read, handed by the sender as one material, read back by the writer under the same names. */
const HANDED_RESULTS = ["resolve_person", "channel_plan", "offer_economics", "brand_profile", "gather_facts", "person_history", "who_they_are", "business_role"];

function at(code: string, anchor: string, name: string): number {
  const first = code.indexOf(anchor);
  if (first < 0 || code.indexOf(anchor, first + 1) >= 0) throw new Error(`the stored follow-up's anchor ${name} is found ${first < 0 ? 0 : "several"} times: nothing generated`);
  return first;
}

/** The whole line starting at `from` (its newline included). */
function lineAt(code: string, from: number): string {
  const end = code.indexOf("\n", from);
  if (end < 0) throw new Error("the stored follow-up ends inside a flow line: nothing generated");
  return code.slice(from, end + 1);
}

const SENDER_ASK = `  if (results.channel_plan?.skipModel === true) {
    // Nothing to write (nobody served, not owed, no channel): no writer is asked, as no model was.
    results.finalize = step_finalize(({ ok: false, skipped: true, notCalled: true }), (results.resolve_person), (results.channel_plan), (flow_input.campaignId));
  } else {
    // THE WRITER composes, asks its model and decides (message_written, WRITER-SENDER-SPLIT-1118): it is handed what
    // the prompt reads and answers the message as it is sent below, or its decision. This script calls no LLM.
    const leadOf: any = typeof results.resolve_person?.leadId === "string" && results.resolve_person.leadId ? results.resolve_person.leadId : null;
    ctx.ask({ units: { ${FOLLOW_UP_REQUESTED}: { content: { now: R.now, trigger: R.trigger ?? null, brief: results.start_run?.brief ?? null, campaignId: flow_input.campaignId ?? null, currentDate: flow_input.currentDate, clock: results.now?.now ?? null, voice: results.read_client_comms ?? null, ${HANDED_RESULTS.map((k) => `${k}: results.${k} ?? null`).join(", ")} } } }, ...(leadOf ? { subject: { service: "lead-service", id: leadOf } } : {}) } as any);
    const written: any = ctx.get("${FOLLOW_UP_WRITER_OUTCOME}");
    const said: any = written && (written.content || written.answer);
    if (!said) throw new Error("the lead follow-up writer answered nothing to act on: " + String((written && written.unmade) || "") + ". Nothing is sent: the run is retried later.");
    results.finalize = said;
  }
`;

const WRITER_RUN_HEAD = `export default function run(ctx: ScriptContext): ScriptResult {
  // Writes the one follow-up a lead gets (WRITER-SENDER-SPLIT-1118): the stored prompt, voice, completion and decision
  // lines, on what its sender read. Calls no door: the sender acts.
  const handed: any = ctx.get("${FOLLOW_UP_REQUESTED}");
  const a: any = (handed && handed.content) || {};
  if (typeof a.now !== "string" || !a.now) throw new Error("the follow-up writer was handed no clock (${FOLLOW_UP_REQUESTED}.now)");
  NOW_MS = RealDate.parse(a.now);
  TRIGGER = a.trigger ?? null;
  const back = (v: any) => (v === null ? undefined : v);
  const flow_input: any = { campaignId: a.campaignId ?? null, currentDate: a.currentDate };
  const results: any = { start_run: { brief: back(a.brief) }, now: { now: back(a.clock) }, read_client_comms: back(a.voice), ${HANDED_RESULTS.map((k) => `${k}: back(a.${k})`).join(", ")} };
`;

const WRITER_RUN_TAIL = `  const made: any = results.finalize;
  const leadOf: any = typeof results.resolve_person?.leadId === "string" && results.resolve_person.leadId ? results.resolve_person.leadId : null;
  if (made.decision === "write") return { content: made, ...(leadOf ? { subject: { service: "lead-service", id: leadOf } } : {}) } as any;
  // A decision that sends nothing is handed back to the sender (no Unit): it sets the date, stops, or alerts the rep.
  return { unmade: String(made.decision) + ": " + String(made.reason ?? made.nextFollowUpWhy ?? ""), decided: "done", answer: made } as any;
}
`;

/** Split the stored follow-up into its writer and its sender. Throws (nothing generated) when an anchor moved. */
export function splitFollowUp(stored: string): { writer: string; sender: string } {
  const code = stored.replace(/\r\n/g, "\n");
  const A = FOLLOW_UP_ANCHORS;
  const runStart = at(code, A.runStart, "runStart");
  const compose = at(code, A.compose, "compose");
  const voiceRead = at(code, A.voiceRead, "voiceRead");
  at(code, A.voiceSkip, "voiceSkip");
  const voiced = at(code, A.voiced, "voiced");
  const draft = at(code, A.draft, "draft");
  const finalize = at(code, A.finalize, "finalize");
  const runEnd = at(code, A.runEnd, "runEnd");
  const composeLine = lineAt(code, compose);
  const voiceReadLine = lineAt(code, voiceRead);
  const voicedLine = lineAt(code, voiced);
  const draftLine = lineAt(code, draft);
  // The five lines follow one another, in this order, with nothing in between: the cut moves exactly them.
  if (!(runStart < compose && compose + composeLine.length === voiceRead && voiceRead + voiceReadLine.length === voiced && voiced + voicedLine.length === draft && draft + draftLine.length === finalize && finalize < runEnd)) {
    throw new Error("the stored follow-up's prompt, voice, completion and decision lines are not contiguous in their order: nothing generated");
  }
  if (!voiceReadLine.endsWith(A.voiceSkip + "\n")) throw new Error("the stored follow-up's voice read does not end on its skip: nothing generated");
  if (code.includes('ctx.get("' + FOLLOW_UP_WRITER_OUTCOME + '")')) throw new Error("the stored follow-up already asks a writer: nothing generated");
  const afterFinalize = finalize + A.finalize.length;
  // No later line may read what the writer keeps (the prompt, the voiced prompt, the draft).
  const rest = code.slice(afterFinalize, runEnd);
  for (const kept of ["compose", "client_comms_voice", "draft"]) {
    if (new RegExp("results\\." + kept + "(?![A-Za-z0-9_])").test(rest)) throw new Error(`the stored follow-up reads results.${kept} after its decision: nothing generated`);
  }

  // The voice is read by the sender at the same place, skipped on the same condition (compose skips exactly then).
  const senderVoice = voiceReadLine.replace(A.voiceSkip, "skip: (results.channel_plan?.skipModel === true) }, 2);");
  // The completion helpers are everything after the run, and the only place the stored code asks the model.
  const tailAt = runEnd + A.runEnd.length;
  if (!code.slice(tailAt).startsWith(A.completionHelpers)) throw new Error("the stored follow-up's completion helpers do not follow its run: nothing generated");
  if (code.slice(0, tailAt).includes('.get("llm_completion")')) throw new Error("the stored follow-up asks its model outside its completion helpers: nothing generated");
  const sender = code.slice(0, compose) + senderVoice + SENDER_ASK + code.slice(afterFinalize, tailAt) + SENDER_NO_MODEL;

  const writer = code.slice(0, runStart) + WRITER_RUN_HEAD + composeLine + voicedLine + draftLine + A.finalize + WRITER_RUN_TAIL + code.slice(tailAt);
  return { writer, sender };
}

/** The tactics each half states. The sender asks its writer and names no model; the writer asks its model. */
export function followUpTactics(storedTactics: Record<string, unknown>): { writer: Record<string, unknown>; sender: Record<string, unknown> } {
  const { llm: _llm, llms: _llms, asks, ...rest } = storedTactics;
  const kept = Array.isArray(asks) ? asks.filter((x): x is string => typeof x === "string" && x !== "llm_completion") : [];
  return {
    writer: { asks: ["llm_completion"], personFields: FOLLOW_UP_PERSON_FIELDS },
    sender: { ...rest, asks: [...new Set([...kept, FOLLOW_UP_WRITER_OUTCOME])] },
  };
}

/** One call a script made, in order: a door (`vendor`) or an ask of another Engine. */
export interface TraceStep {
  kind: "vendor" | "ask";
  name: string;
  args: unknown;
}

export interface SplitTrace {
  steps: TraceStep[];
  /** How the run ended: its result, its failure, or why it stopped. */
  end: { kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string };
}

type RunFn = (
  code: string,
  spec: { subject: string | null; brand: string; day: number; tactics: Record<string, unknown>; request: Record<string, unknown> | null },
  bridge: (op: string, args: unknown[]) => Promise<{ v: unknown } | { stop: string }>,
) => Promise<{ kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string }>;

/** A recorded case of the stored follow-up (a `lead_interested` writer case): what production read and the model's answer. */
export interface StoredFollowUpCase {
  units: Record<string, unknown>;
  request: Record<string, unknown> | null;
  tactics: Record<string, unknown>;
  subject: string | null;
  brand: string;
  day: number;
  calls: Array<{ name: string; args: unknown; answer: { ok: boolean; data: Record<string, unknown> } }>;
  asked: Record<string, unknown>;
}

const json = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * The stored follow-up and its two halves on ONE recorded case, each door answered from the record in order (nothing
 * called, nothing sent) and the model answered by the recorded completion: the doors each called with their bodies,
 * the request each asked the model, and how each ended. `same` = the halves did exactly what the stored code did.
 * `handed` = the material the sender handed its writer (null when no writer was asked): the writer's own case.
 */
export async function compareFollowUpOnCase(
  stored: string,
  halves: { writer: string; sender: string },
  c: StoredFollowUpCase,
  runScriptFn: RunFn,
  same: (a: unknown, b: unknown) => boolean,
): Promise<{ same: boolean; diff: string | null; stored: SplitTrace; split: SplitTrace; handed: { content: Record<string, unknown>; subject: string | null } | null; wrote: boolean }> {
  const spec = { subject: c.subject, brand: c.brand, day: c.day, tactics: c.tactics, request: c.request };
  const completion = c.asked?.llm_completion ?? null;
  const record = () => {
    let next = 0;
    return (name: string): { v: unknown } | { stop: string } => {
      const rec = c.calls[next];
      if (!rec || rec.name !== name) return { stop: `call ${next + 1}: called ${name}, the record ${rec ? "called " + rec.name : "made no more calls"}` };
      next++;
      return { v: json(rec.answer) };
    };
  };

  // The stored code, alone.
  const storedSteps: TraceStep[] = [];
  const answerStored = record();
  const storedEnd = await runScriptFn(stored, spec, async (op, args) => {
    if (op === "vendor") {
      storedSteps.push({ kind: "vendor", name: String(args[0]), args: json(args[1] ?? null) });
      return answerStored(String(args[0]));
    }
    if (op === "ask") {
      storedSteps.push({ kind: "ask", name: "llm_completion", args: json((args[0] as Record<string, unknown>)?.request ?? null) });
      return { v: null };
    }
    if (op === "get") return String(args[0]) === "llm_completion" && completion ? { v: json(completion) } : { stop: `${String(args[0])} not recorded` };
    if (op.startsWith("storage.")) return { v: null };
    return { stop: String(op) };
  });

  // The halves: the sender on the same record; its writer run in between, on what the sender handed it.
  const splitSteps: TraceStep[] = [];
  const answerSplit = record();
  let handed: { content: Record<string, unknown>; subject: string | null } | null = null;
  let pendingAsk: Record<string, unknown> | null = null;
  let wrote = false;
  const splitEnd = await runScriptFn(halves.sender, spec, async (op, args) => {
    if (op === "vendor") {
      splitSteps.push({ kind: "vendor", name: String(args[0]), args: json(args[1] ?? null) });
      return answerSplit(String(args[0]));
    }
    if (op === "ask") {
      pendingAsk = json(args[0] as Record<string, unknown>);
      return { v: null };
    }
    if (op === "get") {
      if (String(args[0]) !== FOLLOW_UP_WRITER_OUTCOME || !pendingAsk) return { stop: `${String(args[0])} asked with nothing handed` };
      const ask = pendingAsk as { units?: Record<string, { content?: Record<string, unknown> }>; subject?: { id?: string } };
      const content = ask.units?.[FOLLOW_UP_REQUESTED]?.content;
      if (!content) return { stop: "the sender handed its writer nothing" };
      handed = { content, subject: ask.subject?.id ?? null };
      const writerEnd = await runScriptFn(halves.writer, { subject: handed.subject, brand: c.brand, day: c.day, tactics: {}, request: null }, async (wop, wargs) => {
        if (wop === "get") {
          if (String(wargs[0]) === FOLLOW_UP_REQUESTED) return { v: { id: "handed", outcome: FOLLOW_UP_REQUESTED, subject: handed!.subject ?? "", ageDays: 0, content: json(content) } };
          return String(wargs[0]) === "llm_completion" && completion ? { v: json(completion) } : { stop: `${String(wargs[0])} not recorded` };
        }
        if (wop === "ask") {
          splitSteps.push({ kind: "ask", name: "llm_completion", args: json((wargs[0] as Record<string, unknown>)?.request ?? null) });
          return { v: null };
        }
        // The writer calls no door, keeps no state.
        return { stop: `the writer asked ${String(wop)}${wop === "vendor" ? " " + String(wargs[0]) : ""}` };
      });
      if (writerEnd.kind === "stopped") return { stop: writerEnd.reason };
      // A failed child stops its asker: the same failure, said once.
      if (writerEnd.kind === "error") return { stop: "writer failed: " + writerEnd.message };
      const result = (writerEnd.result ?? {}) as Record<string, unknown>;
      wrote = !!result.content;
      return { v: json({ id: "written", outcome: FOLLOW_UP_WRITER_OUTCOME, subject: handed.subject ?? "", ageDays: 0, ...(result.content ? { content: result.content } : { unmade: result.unmade, answer: result.answer }) }) };
    }
    if (op.startsWith("storage.")) return { v: null };
    return { stop: String(op) };
  });

  const a: SplitTrace = { steps: storedSteps, end: storedEnd };
  const b: SplitTrace = { steps: splitSteps, end: splitEnd };
  let diff: string | null = null;
  if (a.steps.length !== b.steps.length) diff = `the stored code made ${a.steps.length} calls, the halves ${b.steps.length}`;
  for (let i = 0; diff === null && i < a.steps.length; i++) {
    const x = a.steps[i]!;
    const y = b.steps[i]!;
    if (x.kind !== y.kind || x.name !== y.name) diff = `call ${i + 1}: the stored code made ${x.kind} ${x.name}, the halves ${y.kind} ${y.name}`;
    else if (!same(x.args, y.args)) diff = `call ${i + 1} ${x.name}: not the same request`;
  }
  if (diff === null) {
    // A stored run that failed past its model fails in the writer now (its asker is stopped): the same failure.
    const failedAlike =
      a.end.kind === "error" && b.end.kind === "stopped" && b.end.reason === "writer failed: " + a.end.message;
    if (!failedAlike && !same(a.end, b.end)) diff = `not the same end (${a.end.kind} / ${b.end.kind})`;
  }
  return { same: diff === null, diff, stored: a, split: b, handed, wrote };
}

/** The writer's case hidden in a stored follow-up case: what the sender handed it and the model's recorded answer. */
export function followUpWriterCase(c: StoredFollowUpCase, handed: { content: Record<string, unknown>; subject: string | null }): StoredFollowUpCase {
  return {
    units: { [FOLLOW_UP_REQUESTED]: { content: handed.content } },
    request: null,
    tactics: {},
    subject: handed.subject ?? c.subject,
    brand: c.brand,
    day: c.day,
    calls: [],
    asked: { llm_completion: c.asked?.llm_completion },
  };
}
