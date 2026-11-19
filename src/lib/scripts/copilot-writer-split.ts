/**
 * WRITER-SENDER-SPLIT-1119-COPILOT (owner 2026-11-16 « a script makes ONE outcome, a writer never sends »).
 *
 * The client check-in (`paid_client/dy_client_check_in`) and the brand team answer (`paid_client/dy_brand_team`) served
 * the person, read everything, had the Copilot WRITE the message (chat-service's lead turn: Sophie herself, her prompt,
 * skills, tools and the person's own account when they have one) and SENT it, declaring no `message_written`.
 *
 * Each becomes two scripts, cut from the STORED code at its own flow lines, nothing rewritten (the lead follow-up's cut,
 * `follow-up-split.ts`, on the Copilot's door instead of a completion):
 *
 * - `message_written/<dynasty>` (the WRITER): the prompt (`step_compose`), the turn's plan (`step_copilot_turn_plan`),
 *   the Copilot's lead turn (`chat.copilot.lead_turn`, unchanged: the writer asks SOPHIE, never a bare model, so a lead
 *   or client reads the same brain on every surface) and the decision read (`step_finalize`), verbatim, on what its
 *   sender hands it (material `<dynasty>_requested`). It sends nothing. Made = the message as it will be sent, on the lead
 *   (the runner declares it). Any other decision (later, stop, escalate, cannot_write) = no Unit, handed back (`answer`).
 * - `paid_client/<dynasty>` (the SENDER, an UPGRADE): every other stored line. Nothing to write
 *   (`channel_plan.skipModel`) = no writer asked, as no turn was.
 *
 * Same Copilot answer = the same doors called with the same bodies (`tests/unit/copilot-writer-split.test.ts`; on the
 * dynasty's recorded cases: `scripts/prove-copilot-writer-split.mjs`).
 */

export const COPILOT_WRITER_OUTCOME = "message_written";
export const COPILOT_SENDER_OUTCOME = "paid_client";
export const COPILOT_SPLIT_DYNASTIES = ["dy_client_check_in", "dy_brand_team"] as const;
export type CopilotSplitDynasty = (typeof COPILOT_SPLIT_DYNASTIES)[number];
/** The fields of the writer's Unit a person reads. */
export const COPILOT_PERSON_FIELDS = ["subject", "sequence.*.bodyHtml", "whatsappBody.text", "whatsappBody.messages.*"];

/** The material each sender hands its writer (everything the writer's lines read); no other run holds it. */
export function requestedOf(dynasty: CopilotSplitDynasty): string {
  return `${dynasty.replace(/^dy_/, "")}_requested`;
}

export const COPILOT_SPLIT_TEXT: Record<CopilotSplitDynasty, { writerName: string; writerDescription: string; senderDescription: string }> = {
  dy_client_check_in: {
    writerName: "Client check-in writer",
    writerDescription:
      "Writes the message a current client of the brand gets when something happens with them: the Copilot reads the thread, the facts and who they are to the brand as its sender hands them, and decides to write, wait, stop or hand over to the team.",
    senderDescription:
      "Answers one current client of the brand when something happens with them: reads their thread and the brand's facts, asks the client check-in writer for the message, then sends it on WhatsApp or by email, tells the team when the writer hands over, and leaves their next follow-up date.",
  },
  dy_brand_team: {
    writerName: "Brand team writer",
    writerDescription:
      "Writes the message a member of the brand's own team gets when they write or something happens with them: the Copilot reads the thread, the facts and who they are to the brand as its sender hands them, and decides to write, wait, stop or hand over.",
    senderDescription:
      "Answers one member of the brand's own team when they write or something happens with them: reads their thread and the brand's facts, asks the brand team writer for the message, then sends it on WhatsApp or by email and leaves their next follow-up date.",
  },
};

/** The stored code's own anchors. Each must be found exactly once, else nothing is generated. */
export const COPILOT_ANCHORS = {
  runStart: "export default function run(ctx: ScriptContext): ScriptResult {\n",
  compose: "  results.compose = step_compose(",
  plan: "  results.copilot_turn_plan = step_copilot_turn_plan(",
  draft: '  results.draft = callStep(ctx, "chat.copilot.lead_turn", ',
  finalize: "  results.finalize = step_finalize((results.draft), (results.resolve_person), (results.channel_plan), (flow_input.campaignId));\n",
  runEnd: '  throw new Error("the run reached no end");\n}\n',
};

/** What the writer's lines read, handed by the sender as one material, read back under the same names. */
const HANDED_RESULTS = ["occurrence", "trigger_type", "resolve_person", "channel_plan", "offer_economics", "brand_profile", "gather_facts", "person_history", "who_they_are", "business_role"];

function at(code: string, anchor: string, name: string): number {
  const first = code.indexOf(anchor);
  if (first < 0 || code.indexOf(anchor, first + 1) >= 0) throw new Error(`the stored script's anchor ${name} is found ${first < 0 ? 0 : "several"} times: nothing generated`);
  return first;
}

function lineAt(code: string, from: number): string {
  const end = code.indexOf("\n", from);
  if (end < 0) throw new Error("the stored script ends inside a flow line: nothing generated");
  return code.slice(from, end + 1);
}

function senderAsk(requested: string): string {
  return `  if (results.channel_plan?.skipModel === true) {
    // Nothing to write (nobody served, not owed, no channel): no writer is asked, as no Copilot turn was.
    results.finalize = step_finalize(({ ok: false, skipped: true, notCalled: true }), (results.resolve_person), (results.channel_plan), (flow_input.campaignId));
  } else {
    // THE WRITER composes, asks the Copilot and decides (message_written, WRITER-SENDER-SPLIT-1119-COPILOT): it is
    // handed what the prompt reads and answers the message as it is sent below, or its decision.
    const leadOf: any = typeof results.resolve_person?.leadId === "string" && results.resolve_person.leadId ? results.resolve_person.leadId : null;
    ctx.ask({ units: { ${requested}: { content: { now: R.now, trigger: flow_input.trigger ?? null, campaignId: flow_input.campaignId ?? null, currentDate: flow_input.currentDate, brief: results.start_run?.brief ?? null, clock: results.now?.now ?? null, ${HANDED_RESULTS.map((k) => `${k}: results.${k} ?? null`).join(", ")} } } }, ...(leadOf ? { subject: { service: "lead-service", id: leadOf } } : {}) } as any);
    const written: any = ctx.get("${COPILOT_WRITER_OUTCOME}");
    const said: any = written && (written.content || written.answer);
    if (!said) throw new Error("the writer answered nothing to act on: " + String((written && written.unmade) || "") + ". Nothing is sent: the run is retried later.");
    results.finalize = said;
  }
`;
}

function writerHead(requested: string): string {
  return `export default function run(ctx: ScriptContext): ScriptResult {
  // Writes the one message (WRITER-SENDER-SPLIT-1119-COPILOT): the stored prompt, the Copilot's lead turn and the
  // decision lines, on what its sender read. Sends nothing: the sender acts.
  const handed: any = ctx.get("${requested}");
  const a: any = (handed && handed.content) || {};
  if (typeof a.now !== "string" || !a.now) throw new Error("the writer was handed no clock (${requested}.now)");
  NOW_MS = RealDate.parse(a.now);
  TRIGGER = a.trigger ?? null;
  const back = (v: any) => (v === null ? undefined : v);
  const flow_input: any = { campaignId: a.campaignId ?? null, currentDate: a.currentDate, trigger: a.trigger ?? null };
  const results: any = { start_run: { brief: back(a.brief) }, now: { now: back(a.clock) }, ${HANDED_RESULTS.map((k) => `${k}: back(a.${k})`).join(", ")} };
`;
}

const WRITER_RUN_TAIL = `  const made: any = results.finalize;
  const leadOf: any = typeof results.resolve_person?.leadId === "string" && results.resolve_person.leadId ? results.resolve_person.leadId : null;
  if (made.decision === "write") return { content: made, ...(leadOf ? { subject: { service: "lead-service", id: leadOf } } : {}) } as any;
  // A decision that sends nothing is handed back to the sender (no Unit): it sets the date, stops, or alerts the team.
  return { unmade: String(made.decision) + ": " + String(made.reason ?? made.nextFollowUpWhy ?? ""), decided: "done", answer: made } as any;
}
`;

/** Split a stored Copilot-writing script into its writer and its sender. Throws (nothing generated) when an anchor moved. */
export function splitCopilotWriter(stored: string, dynasty: CopilotSplitDynasty): { writer: string; sender: string } {
  const code = stored.replace(/\r\n/g, "\n");
  const A = COPILOT_ANCHORS;
  const requested = requestedOf(dynasty);
  const runStart = at(code, A.runStart, "runStart");
  const compose = at(code, A.compose, "compose");
  const plan = at(code, A.plan, "plan");
  const draft = at(code, A.draft, "draft");
  const finalize = at(code, A.finalize, "finalize");
  const runEnd = at(code, A.runEnd, "runEnd");
  const composeLine = lineAt(code, compose);
  const planLine = lineAt(code, plan);
  const draftLine = lineAt(code, draft);
  // The four lines follow one another, in this order, with nothing in between: the cut moves exactly them.
  if (!(runStart < compose && compose + composeLine.length === plan && plan + planLine.length === draft && draft + draftLine.length === finalize && finalize < runEnd)) {
    throw new Error("the stored script's prompt, turn plan, Copilot turn and decision lines are not contiguous in their order: nothing generated");
  }
  if (!draftLine.includes("skip: (results.compose?.skip) }")) throw new Error("the stored Copilot turn is not skipped on the prompt's skip: nothing generated");
  if (code.includes('ctx.get("' + COPILOT_WRITER_OUTCOME + '")')) throw new Error("the stored script already asks a writer: nothing generated");
  if (code.slice(runEnd + A.runEnd.length).trim() !== "") throw new Error("the stored script carries code after its run: nothing generated");
  const afterFinalize = finalize + A.finalize.length;
  const rest = code.slice(afterFinalize, runEnd);
  for (const kept of ["compose", "copilot_turn_plan", "draft"]) {
    if (new RegExp("results\\." + kept + "(?![A-Za-z0-9_])").test(rest)) throw new Error(`the stored script reads results.${kept} after its decision: nothing generated`);
  }
  // What the four lines read must be what the sender hands.
  const read = new Set([...(composeLine + planLine + draftLine).matchAll(/results\.([a-z_]+)/g)].map((m) => m[1]!));
  const handed = new Set([...HANDED_RESULTS, "start_run", "now", "compose", "copilot_turn_plan", "draft"]);
  const missing = [...read].filter((k) => !handed.has(k));
  if (missing.length) throw new Error(`the stored writing lines read ${missing.join(", ")}, which the sender does not hand: nothing generated`);
  if (/results\.start_run\?\.(?!brief\b)/.test(composeLine + planLine + draftLine)) throw new Error("the stored writing lines read more of the run's start than its brief: nothing generated");
  for (const f of (composeLine + planLine + draftLine).matchAll(/flow_input\.([a-zA-Z_]+)/g)) {
    if (!["campaignId", "currentDate", "trigger"].includes(f[1]!)) throw new Error(`the stored writing lines read flow_input.${f[1]}, which the sender does not hand: nothing generated`);
  }

  const sender = code.slice(0, compose) + senderAsk(requested) + code.slice(afterFinalize);
  const writer = code.slice(0, runStart) + writerHead(requested) + composeLine + planLine + draftLine + A.finalize + WRITER_RUN_TAIL;
  return { writer, sender };
}

/** The tactics each half states. The sender keeps its own and asks its writer; the writer states the fields a person reads. */
export function copilotSplitTactics(storedTactics: Record<string, unknown>): { writer: Record<string, unknown>; sender: Record<string, unknown> } {
  const { asks, ...rest } = storedTactics;
  const kept = Array.isArray(asks) ? asks.filter((x): x is string => typeof x === "string") : [];
  return {
    writer: { personFields: COPILOT_PERSON_FIELDS },
    sender: { ...rest, asks: [...new Set([...kept, COPILOT_WRITER_OUTCOME])] },
  };
}

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

/** A recorded replay case (`script_cases`): the request, every door's answer in order, what production ended on. */
export interface CopilotCase {
  id: string;
  units?: Record<string, unknown>;
  request?: Record<string, unknown> | null;
  tactics?: Record<string, unknown>;
  subject?: string | null;
  day?: number;
  calls: Array<{ name: string; args?: unknown; answer: { ok: boolean; data: Record<string, unknown> } }>;
  expect?: Record<string, unknown>;
}

const json = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/**
 * The stored script and its two halves on ONE recorded case, each door answered from the record in order (nothing
 * called, nothing sent, the Copilot's turn included): the doors each called with their bodies and how each ended.
 */
export async function compareCopilotOnCase(
  stored: string,
  halves: { writer: string; sender: string },
  dynasty: CopilotSplitDynasty,
  c: CopilotCase,
  runScriptFn: RunFn,
  same: (a: unknown, b: unknown) => boolean,
): Promise<{ same: boolean; diff: string | null; stored: SplitTrace; split: SplitTrace; ask: Record<string, unknown> | null; said: Record<string, unknown> | null; senderCalls: CopilotCase["calls"] }> {
  const requested = requestedOf(dynasty);
  const spec = { subject: c.subject ?? null, brand: "replay", day: c.day ?? 0, tactics: c.tactics ?? {}, request: c.request ?? null };
  const record = () => {
    let next = 0;
    return (name: string): { v: unknown } | { stop: string } => {
      const rec = c.calls[next];
      if (!rec || rec.name !== name) return { stop: `call ${next + 1}: called ${name}, the record ${rec ? "called " + rec.name : "made no more calls"}` };
      next++;
      return { v: json(rec.answer) };
    };
  };
  const units = c.units ?? {};
  const getUnit = (outcome: string): { v: unknown } | { stop: string } =>
    units[outcome] !== undefined ? { v: { id: `${c.id}:${outcome}`, outcome, subject: c.subject ?? "", ageDays: 0, content: json(units[outcome]) } } : { stop: `${outcome} not recorded` };

  const storedSteps: TraceStep[] = [];
  const answerStored = record();
  const storedEnd = await runScriptFn(stored, spec, async (op, args) => {
    if (op === "vendor") {
      storedSteps.push({ kind: "vendor", name: String(args[0]), args: json(args[1] ?? null) });
      return answerStored(String(args[0]));
    }
    if (op === "get") return getUnit(String(args[0]));
    if (op.startsWith("storage.")) return { v: null };
    return { stop: String(op) };
  });

  const splitSteps: TraceStep[] = [];
  const senderCalls: CopilotCase["calls"] = [];
  const answerSplit = record();
  let pendingAsk: Record<string, unknown> | null = null;
  let ask: Record<string, unknown> | null = null;
  let said: Record<string, unknown> | null = null;
  const splitEnd = await runScriptFn(halves.sender, spec, async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      splitSteps.push({ kind: "vendor", name, args: json(args[1] ?? null) });
      const a = answerSplit(name);
      if ("v" in a) senderCalls.push({ name, args: json(args[1] ?? null), answer: a.v as CopilotCase["calls"][number]["answer"] });
      return a;
    }
    if (op === "ask") {
      pendingAsk = json(args[0] as Record<string, unknown>);
      return { v: null };
    }
    if (op === "get") {
      if (String(args[0]) !== COPILOT_WRITER_OUTCOME) return getUnit(String(args[0]));
      if (!pendingAsk) return { stop: `${String(args[0])} asked with nothing handed` };
      ask = pendingAsk;
      const asked = pendingAsk as { units?: Record<string, { content?: Record<string, unknown> }>; subject?: { id?: string } };
      const content = asked.units?.[requested]?.content;
      if (!content) return { stop: "the sender handed its writer nothing" };
      const subject = asked.subject?.id ?? null;
      const writerEnd = await runScriptFn(halves.writer, { subject, brand: "replay", day: c.day ?? 0, tactics: {}, request: null }, async (wop, wargs) => {
        if (wop === "get" && String(wargs[0]) === requested) return { v: { id: "handed", outcome: requested, subject: subject ?? "", ageDays: 0, content: json(content) } };
        if (wop === "vendor") {
          const name = String(wargs[0]);
          // The writer's one door: the Copilot's lead turn. Anything that sends is the sender's.
          if (name !== "chat.copilot.lead_turn") return { stop: `the writer called ${name}` };
          splitSteps.push({ kind: "vendor", name, args: json(wargs[1] ?? null) });
          return answerSplit(name);
        }
        return { stop: `the writer asked ${String(wop)}` };
      });
      if (writerEnd.kind === "stopped") return { stop: writerEnd.reason };
      if (writerEnd.kind === "error") return { stop: "writer failed: " + writerEnd.message };
      const result = (writerEnd.result ?? {}) as Record<string, unknown>;
      said = ((result.content ?? result.answer) as Record<string, unknown>) ?? null;
      return { v: json({ id: "written", outcome: COPILOT_WRITER_OUTCOME, subject: subject ?? "", ageDays: 0, ...(result.content ? { content: result.content } : { unmade: result.unmade, answer: result.answer }) }) };
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
    const failedAlike = a.end.kind === "error" && b.end.kind === "stopped" && b.end.reason === "writer failed: " + a.end.message;
    if (!failedAlike && !same(a.end, b.end)) diff = `not the same end (${a.end.kind} / ${b.end.kind})`;
  }
  return { same: diff === null, diff, stored: a, split: b, ask, said, senderCalls };
}

/**
 * The sender's own replay case restated from a case it was compared on: the record minus the Copilot's turn, its ask,
 * and what the writer answered (its Unit, or its decision) as the material it reads. The expectation is the case's own.
 */
export function copilotSenderCase(c: CopilotCase, r: { ask: Record<string, unknown> | null; said: Record<string, unknown> | null; senderCalls: CopilotCase["calls"] }): CopilotCase & { asks: unknown[] } {
  if (!r.ask || !r.said) throw new Error(`case ${c.id}: the sender asked no writer, its recorded case stands as it is`);
  return { ...c, units: { ...(c.units ?? {}), [COPILOT_WRITER_OUTCOME]: r.said }, calls: r.senderCalls, asks: [r.ask] };
}
