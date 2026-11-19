/**
 * WRITER-SENDER-SPLIT-1119-FOUNDER (owner 2026-11-16 « a script makes ONE outcome, a writer never sends »).
 *
 * The founder hello (`whatsapp_message_sent/dy_founder_hello`) read the person, composed the hello, asked its model,
 * had content-generation store the message (which declares `message_written` on the run that asked the completion:
 * the founder hello's own run) and SENT it: one script, two outcomes on one run (prod 2026-11-19, run 14a28cdb).
 *
 * It becomes two scripts, cut from the STORED code (the source of truth) at its own flow lines, nothing rewritten:
 *
 * - `message_written/dy_founder_hello` (the WRITER): `compose` (the context and variables the template reads), the
 *   template pick, its head, the completion asked of the LLM completion Engine, content-generation's store, and
 *   `finalize` (the hello and the assistant's first message, as they are sent): the stored lines, verbatim, on what its
 *   sender hands it (material `founder_hello_requested`, which only that sender hands). It calls no door that sends.
 *   Made = the `finalize` result, on the lead. content-generation stores the message and declares it on THIS run (the
 *   door fills `completion.runId` with the writer's run), so the sender asks it with `recordedBy` content: one
 *   declaration per Unit, never two. A writer that cannot write fails, as the stored code did (no hello is ever
 *   "later": `finalize` throws on any other decision).
 * - `whatsapp_message_sent/dy_founder_hello` (the SENDER, an UPGRADE): every stored line but those. It claims, reads,
 *   admits, checks the reach, reads the brand and the voice samples, asks the writer, then sends the hello, hands the
 *   person to the assistant line and records the look, exactly as stored. Nobody to greet (`verdict.skip`) = no writer
 *   asked, as no model was.
 *
 * Same model answer = the same doors called with the same bodies (`tests/unit/founder-hello-split.test.ts`; on
 * production's recorded cases: `scripts/prove-founder-hello-split.mjs`).
 */

export const FOUNDER_HELLO_WRITER_OUTCOME = "message_written";
export const FOUNDER_HELLO_SENDER_OUTCOME = "whatsapp_message_sent";
export const FOUNDER_HELLO_DYNASTY = "dy_founder_hello";
/** The material the sender hands its writer (everything compose and finalize read); no other run holds it. */
export const FOUNDER_HELLO_REQUESTED = "founder_hello_requested";
/** The service that records the writer's Unit (content-generation declares `message_written` on the writer's run). */
export const FOUNDER_HELLO_WRITER_RECORDED_BY = "content";
/** The fields of the writer's Unit a person reads (its pair proofs judge them). */
export const FOUNDER_HELLO_PERSON_FIELDS = ["text", "assistantText"];
export const FOUNDER_HELLO_WRITER_NAME = "Founder hello writer";
export const FOUNDER_HELLO_WRITER_DESCRIPTION =
  "Writes the founder's one WhatsApp hello to a person who just set up the product, naming what they set up, and the assistant's first message right after it, from what its sender read; the model is the one the Rating picks.";
export const FOUNDER_HELLO_SENDER_DESCRIPTION =
  "Says hello once on WhatsApp from the founder's line to a person who just set up the product: checks they are not already greeted or talking to us, asks the founder hello writer for the message, sends it, then hands them to the assistant line.";

/** The stored code's own anchors. Each must be found exactly once, else nothing is generated. */
export const FOUNDER_HELLO_ANCHORS = {
  /** The doors only the sender calls, before the run: the thread read and the WhatsApp send (the writer drops them). */
  senderDoors: "/** A person-thread read waits for crm-service's settled thread",
  runStart: "export default function run(ctx: ScriptContext): ScriptResult {\n",
  compose: "  const composed = compose(person, verdict, thread, brand, rep, String(R.now).slice(0, 10), v[0], v[1], v[2], t[0], t[1], t[2]);\n",
  finalize: "  const final = finalize(composed, draft, person, campaignId, verdict, null, null);\n",
  runEnd: '  throw new Error("founder-hello: the run ended " + JSON.stringify(outcome.endKind) + ", which no live run can reach");\n}\n',
  /** After the run: the template writer's request and the helpers that ask the LLM completion Engine (the writer's alone). */
  completionHelpers: "\n/** ONE-WRITER-N-MODELS-1116-OTHERS: the template's writer request",
  /** The stored writer request named its run itself; the writer's door fills it (an asked writer cannot know its run). */
  runIdOfRequest:
    '  const runId = ctx.request && typeof ctx.request.runId === "string" ? ctx.request.runId : "";\n  if (!runId) throw new Error(door + ": the run states no runId (the run that asked the completion)");\n  return must(ctx, door + ".generate", { body: { ...body, ...extra, completion: { request: sent, answer: done.content.answer, runId } } });\n',
};

const WRITER_GENERATE = `  // The message is declared on this writer's own run: the door fills completion.runId (WRITER-SENDER-SPLIT-1119-FOUNDER).
  return must(ctx, door + ".generate", { body: { ...body, ...extra, completion: { request: sent, answer: done.content.answer } } });
`;

/** The stored values the writer's lines read, handed by the sender under the same names. */
const HANDED = ["person", "verdict", "thread", "brand", "rep", "v", "t"];

function at(code: string, anchor: string, name: string): number {
  const first = code.indexOf(anchor);
  if (first < 0 || code.indexOf(anchor, first + 1) >= 0) throw new Error(`the stored founder hello's anchor ${name} is found ${first < 0 ? 0 : "several"} times: nothing generated`);
  return first;
}

const SENDER_ASK = `  // THE WRITER composes the hello, asks its model and reads its answer (message_written, WRITER-SENDER-SPLIT-1119-FOUNDER):
  // it is handed what was read and answers the messages as they are sent below. Nobody to greet = no writer asked, as no
  // model was. This script calls no LLM.
  const final: any = verdict.skip !== false
    ? finalize({ skip: true, variables: null, message: null }, NOT_CALLED, person, campaignId, verdict, null, null)
    : askFounderHelloWriter(ctx, { now: R.now, brief: R.brief ?? null, campaignId: campaignId ?? null, ${HANDED.map((k) => `${k}`).join(", ")} }, person.leadId);
`;

const SENDER_HELPER = `
/** WRITER-SENDER-SPLIT-1119-FOUNDER: the founder hello writer, asked with what was read; content-generation records its Unit. */
function askFounderHelloWriter(ctx: any, handed: Record<string, unknown>, leadId: unknown): any {
  const lead = typeof leadId === "string" && leadId ? leadId : null;
  ctx.ask({ units: { ${FOUNDER_HELLO_REQUESTED}: { content: handed } }, ...(lead ? { subject: { service: "lead-service", id: lead } } : {}), recordedBy: "${FOUNDER_HELLO_WRITER_RECORDED_BY}" } as any);
  const written: any = ctx.get("${FOUNDER_HELLO_WRITER_OUTCOME}");
  if (!written || !written.content) throw new Error("the founder hello writer wrote nothing to send: " + String((written && written.unmade) || "") + ". Nothing is sent: the run is retried later.");
  return written.content;
}
`;

const WRITER_RUN_HEAD = `export default function run(ctx: ScriptContext): ScriptResult {
  // Writes the founder hello (WRITER-SENDER-SPLIT-1119-FOUNDER): the stored compose, template, completion and finalize
  // lines, on what its sender read. Sends nothing: the sender does.
  const handed: any = ctx.get("${FOUNDER_HELLO_REQUESTED}");
  const a: any = (handed && handed.content) || {};
  if (typeof a.now !== "string" || !a.now) throw new Error("the founder hello writer was handed no clock (${FOUNDER_HELLO_REQUESTED}.now)");
  const back = (x: any) => (x === null ? undefined : x);
  const R: any = { now: a.now, brief: back(a.brief) };
  const campaignId: any = back(a.campaignId);
  ${HANDED.map((k) => `const ${k}: any = a.${k};`).join(" ")}
`;

const WRITER_RUN_TAIL = `  // The hello as it is sent, and the assistant's first message: its sender sends them.
  return { content: final, ...(typeof person?.leadId === "string" && person.leadId ? { subject: { service: "lead-service", id: person.leadId } } : {}) } as any;
}
`;

/** Split the stored founder hello into its writer and its sender. Throws (nothing generated) when an anchor moved. */
export function splitFounderHello(stored: string): { writer: string; sender: string } {
  const code = stored.replace(/\r\n/g, "\n");
  const A = FOUNDER_HELLO_ANCHORS;
  const senderDoors = at(code, A.senderDoors, "senderDoors");
  const runStart = at(code, A.runStart, "runStart");
  const compose = at(code, A.compose, "compose");
  const finalize = at(code, A.finalize, "finalize");
  const runEnd = at(code, A.runEnd, "runEnd");
  if (!(senderDoors < runStart && runStart < compose && compose < finalize && finalize < runEnd)) throw new Error("the stored founder hello's flow lines are not in their order: nothing generated");
  if (code.includes('ctx.get("' + FOUNDER_HELLO_WRITER_OUTCOME + '")')) throw new Error("the stored founder hello already asks a writer: nothing generated");
  const afterFinalize = finalize + A.finalize.length;
  // No later line may read what the writer keeps (the context, the pick, the template head, the draft).
  const rest = code.slice(afterFinalize, runEnd);
  for (const kept of ["composed", "skipWrite", "pick", "writer", "head", "draft"]) {
    if (new RegExp("(?<![A-Za-z0-9_.])" + kept + "(?![A-Za-z0-9_])").test(rest)) throw new Error(`the stored founder hello reads ${kept} after its finalize: nothing generated`);
  }
  // The writer's lines read only what the sender hands, the clock, the brief and the run's campaign.
  const flow = code.slice(compose, afterFinalize);
  if (!flow.includes("askedWriter(ctx, ")) throw new Error("the stored founder hello's writing lines ask no template writer: nothing generated");
  // The completion helpers are everything after the run, and the only place the stored code asks the model.
  const tailAt = runEnd + A.runEnd.length;
  const tail = code.slice(tailAt);
  if (!tail.startsWith(A.completionHelpers)) throw new Error("the stored founder hello's completion helpers do not follow its run: nothing generated");
  if (code.slice(0, tailAt).includes('.get("llm_completion")')) throw new Error("the stored founder hello asks its model outside its completion helpers: nothing generated");
  at(tail, A.runIdOfRequest, "runIdOfRequest");
  // The doors only the sender calls sit right before the run: the writer leaves them out (it sends to nobody).
  if (code.slice(senderDoors, runStart).includes("export ")) throw new Error("the stored founder hello's sender doors are not right before its run: nothing generated");

  const sender = code.slice(0, compose) + SENDER_ASK + code.slice(afterFinalize, tailAt) + SENDER_HELPER;
  const writer = code.slice(0, senderDoors) + WRITER_RUN_HEAD + flow + WRITER_RUN_TAIL + tail.replace(A.runIdOfRequest, WRITER_GENERATE);
  return { writer, sender };
}

/** The tactics each half states. The sender asks its writer and names no template; the writer asks its model. */
export function founderHelloTactics(storedTactics: Record<string, unknown>): { writer: Record<string, unknown>; sender: Record<string, unknown> } {
  const { llm: _llm, llms: _llms, template, templates, asks, ...rest } = storedTactics;
  const kept = Array.isArray(asks) ? asks.filter((x): x is string => typeof x === "string" && x !== "llm_completion") : [];
  return {
    writer: { asks: ["llm_completion"], ...(template !== undefined ? { template } : {}), ...(templates !== undefined ? { templates } : {}), personFields: FOUNDER_HELLO_PERSON_FIELDS },
    sender: { ...rest, asks: [...new Set([...kept, FOUNDER_HELLO_WRITER_OUTCOME])] },
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
  end: { kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string };
}

type RunFn = (
  code: string,
  spec: { subject: string | null; brand: string; day: number; tactics: Record<string, unknown>; request: Record<string, unknown> | null },
  bridge: (op: string, args: unknown[]) => Promise<{ v: unknown } | { stop: string }>,
) => Promise<{ kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string }>;

/** A recorded case of the stored founder hello: what production read, every door's answer, and the model's answer. */
export interface StoredFounderHelloCase {
  units: Record<string, unknown>;
  request: Record<string, unknown> | null;
  tactics: Record<string, unknown>;
  subject: string | null;
  brand: string;
  day: number;
  calls: Array<{ name: string; args?: unknown; answer: { ok: boolean; data: Record<string, unknown> } }>;
  asked: Record<string, unknown>;
}

const json = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** The door fills `completion.runId` of a generate call: compared without it (the stored code stated its own run). */
function comparable(name: string, args: unknown): unknown {
  if (name !== "content.whatsapp.generate" || !args || typeof args !== "object") return args;
  const body = (args as { body?: Record<string, unknown> }).body;
  const completion = body?.completion;
  if (!completion || typeof completion !== "object") return args;
  const { runId: _run, ...kept } = completion as Record<string, unknown>;
  return { ...(args as Record<string, unknown>), body: { ...body, completion: kept } };
}

/**
 * The stored founder hello and its two halves on ONE recorded case, each door answered from the record in order (nothing
 * called, nothing sent) and the model answered by the recorded completion: the doors each called with their bodies, the
 * request each asked the model, and how each ended. `same` = the halves did exactly what the stored code did.
 * `handed` = what the sender handed its writer (null when no writer was asked); `ask` = the sender's whole ask.
 */
export async function compareFounderHelloOnCase(
  stored: string,
  halves: { writer: string; sender: string },
  c: StoredFounderHelloCase,
  runScriptFn: RunFn,
  same: (a: unknown, b: unknown) => boolean,
): Promise<{ same: boolean; diff: string | null; stored: SplitTrace; split: SplitTrace; handed: { content: Record<string, unknown>; subject: string | null } | null; ask: Record<string, unknown> | null; written: Record<string, unknown> | null; senderSteps: TraceStep[] }> {
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
      storedSteps.push({ kind: "vendor", name: String(args[0]), args: comparable(String(args[0]), json(args[1] ?? null)) });
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
  const senderSteps: TraceStep[] = [];
  const answerSplit = record();
  let handed: { content: Record<string, unknown>; subject: string | null } | null = null;
  let pendingAsk: Record<string, unknown> | null = null;
  let ask: Record<string, unknown> | null = null;
  let written: Record<string, unknown> | null = null;
  const splitEnd = await runScriptFn(halves.sender, spec, async (op, args) => {
    if (op === "vendor") {
      const step: TraceStep = { kind: "vendor", name: String(args[0]), args: json(args[1] ?? null) };
      splitSteps.push(step);
      senderSteps.push(step);
      return answerSplit(String(args[0]));
    }
    if (op === "ask") {
      pendingAsk = json(args[0] as Record<string, unknown>);
      return { v: null };
    }
    if (op === "get") {
      if (String(args[0]) !== FOUNDER_HELLO_WRITER_OUTCOME || !pendingAsk) return { stop: `${String(args[0])} asked with nothing handed` };
      ask = pendingAsk;
      const asked = pendingAsk as { units?: Record<string, { content?: Record<string, unknown> }>; subject?: { id?: string }; recordedBy?: unknown };
      if (asked.recordedBy !== FOUNDER_HELLO_WRITER_RECORDED_BY) return { stop: `the sender asked its writer recorded by ${String(asked.recordedBy)}` };
      const content = asked.units?.[FOUNDER_HELLO_REQUESTED]?.content;
      if (!content) return { stop: "the sender handed its writer nothing" };
      handed = { content, subject: asked.subject?.id ?? null };
      const writerEnd = await runScriptFn(halves.writer, { subject: handed.subject, brand: c.brand, day: c.day, tactics: {}, request: null }, async (wop, wargs) => {
        if (wop === "get") {
          if (String(wargs[0]) === FOUNDER_HELLO_REQUESTED) return { v: { id: "handed", outcome: FOUNDER_HELLO_REQUESTED, subject: handed!.subject ?? "", ageDays: 0, content: json(content) } };
          return String(wargs[0]) === "llm_completion" && completion ? { v: json(completion) } : { stop: `${String(wargs[0])} not recorded` };
        }
        if (wop === "ask") {
          splitSteps.push({ kind: "ask", name: "llm_completion", args: json((wargs[0] as Record<string, unknown>)?.request ?? null) });
          return { v: null };
        }
        if (wop === "vendor") {
          // The writer's doors write, never send: the template pick, its head, content-generation's request and store.
          const name = String(wargs[0]);
          if (name === "crm.whatsapp.send") return { stop: "the writer sent" };
          if (name === "content.whatsapp.generate" && (wargs[1] as { body?: { completion?: Record<string, unknown> } })?.body?.completion?.runId !== undefined) return { stop: "the writer named its run (the door fills it)" };
          splitSteps.push({ kind: "vendor", name, args: json(wargs[1] ?? null) });
          return answerSplit(name);
        }
        return { stop: `the writer asked ${String(wop)}` };
      });
      if (writerEnd.kind === "stopped") return { stop: writerEnd.reason };
      if (writerEnd.kind === "error") return { stop: "writer failed: " + writerEnd.message };
      const result = (writerEnd.result ?? {}) as Record<string, unknown>;
      written = (result.content as Record<string, unknown>) ?? null;
      return { v: json({ id: "written", outcome: FOUNDER_HELLO_WRITER_OUTCOME, subject: handed.subject ?? "", ageDays: 0, ...(result.content ? { content: result.content } : { unmade: result.unmade, answer: result.answer }) }) };
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
    // A stored run that failed in its writing lines fails in the writer now (its asker is stopped): the same failure.
    const failedAlike = a.end.kind === "error" && b.end.kind === "stopped" && b.end.reason === "writer failed: " + a.end.message;
    if (!failedAlike && !same(a.end, b.end)) diff = `not the same end (${a.end.kind} / ${b.end.kind})`;
  }
  return { same: diff === null, diff, stored: a, split: b, handed, ask, written, senderSteps };
}

/** A recorded replay case (`script_cases`) read as a stored case: the same record, nothing asked of a model. */
export function storedCaseOfReplay(c: { units?: Record<string, unknown>; request?: Record<string, unknown> | null; tactics?: Record<string, unknown>; subject?: string | null; day?: number; calls: StoredFounderHelloCase["calls"] }): StoredFounderHelloCase {
  return { units: c.units ?? {}, request: c.request ?? null, tactics: c.tactics ?? {}, subject: c.subject ?? null, brand: "replay", day: c.day ?? 0, calls: c.calls, asked: {} };
}

/**
 * The sender's own replay case restated from a stored case it was compared on (the same record minus the writer's doors,
 * its ask, the writer's Unit as the material it gets, the stored result as its expected content).
 */
export function senderReplayCase(
  id: string,
  c: StoredFounderHelloCase,
  r: { ask: Record<string, unknown> | null; written: Record<string, unknown> | null; senderSteps: TraceStep[]; stored: SplitTrace },
): Record<string, unknown> {
  if (!r.ask || !r.written) throw new Error(`case ${id}: the sender asked no writer, its recorded case stands as it is`);
  if (r.stored.end.kind !== "done") throw new Error(`case ${id}: the stored code did not end with a result`);
  const result = (r.stored.end.result ?? {}) as Record<string, unknown>;
  const writerDoors = new Set(["template.pick", "content.template_head", "content.whatsapp.request", "content.whatsapp.generate"]);
  const calls = c.calls.filter((x) => !writerDoors.has(x.name)).map((x) => ({ name: x.name, args: x.args, answer: x.answer }));
  if (calls.length !== r.senderSteps.length) throw new Error(`case ${id}: the sender made ${r.senderSteps.length} calls, the record minus the writer's ${calls.length}`);
  return {
    id,
    units: { [FOUNDER_HELLO_WRITER_OUTCOME]: r.written },
    ...(c.subject ? { subject: c.subject } : {}),
    ...(c.request ? { request: c.request } : {}),
    asks: [r.ask],
    calls,
    expect: result.content ? { content: result.content } : result.unmade ? { fails: String(result.unmade) } : { nothing: true },
  };
}
