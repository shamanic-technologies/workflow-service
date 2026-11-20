/**
 * SEND-CHECK-BEFORE-WRITE-1120: an email is checked BEFORE its writer is asked.
 *
 * The three senders that ask a writer and then email (`lead_interested/dy_follow_up_due`, `paid_client/dy_client_check_in`,
 * `paid_client/dy_brand_team`) learned only at `email.send` that the address may not be mailed: 125 messages written
 * (paid LLM / Copilot turns) then refused in 7 days, 8 of 27 email sends since the writer/sender cut. The send's own
 * checks on the person are now asked first, through `email.send_check` (email-gateway `POST /orgs/send-checks`: the
 * route the send would take, then instantly-service's door checks: opt-out, not a prospect, stated not to the brand, an
 * address our verifier judged invalid; a verdict < 30 days is reused free, else verified now on the run and reused free
 * by the send right after).
 *
 * The edit is made on each sender's STORED code at its own lines, nothing else rewritten (`addSendCheck`):
 * - right after the channel plan, an EMAIL channel asks `email.send_check`;
 * - a refusal = no writer asked, no reads for it, and the refusal is acted on exactly as the send's own refusal was
 *   (the run's outcome step reads it as `send_email`): same next follow-up date (30 days on an unverified address),
 *   same row, same delivery, same end;
 * - a pass = the run goes on byte for byte as before (the send right after reuses the verdict).
 *
 * Proven on each dynasty's recorded cases (`compareSendCheckOnCase`, `scripts/prove-send-check-before-write.mjs`).
 */

export const SEND_CHECK_DOOR = "email.send_check";
/** The send's refusals on the PERSON, which the check answers alike (never our own queued work's). */
export const SEND_CHECK_REFUSAL_CODES = ["lead_opted_out", "lead_not_a_prospect", "stated_not_to_brand", "email_not_verified"] as const;

export const SEND_CHECK_SENDERS = [
  { outcome: "lead_interested", dynasty: "dy_follow_up_due" },
  { outcome: "paid_client", dynasty: "dy_client_check_in" },
  { outcome: "paid_client", dynasty: "dy_brand_team" },
] as const;

/** The stored code's own lines (each found exactly once, else nothing is generated). */
export const SEND_CHECK_ANCHORS = {
  channelPlan: "  results.channel_plan = step_channel_plan((results.resolve_person), (results.read_state), (results.reach_check), (results.person_thread));\n",
  writerBranch: "  if (results.channel_plan?.skipModel === true) {\n",
  sendEmail: '  results.send_email = callStep(ctx, "email.send", ',
  afterSends: "  results.compose_rep_alert = step_compose_rep_alert(",
};

const CHECK_LINES =
  "  // SEND-CHECK-BEFORE-WRITE-1120: an email is checked before its writer is asked: the send's own refusals on the person\n" +
  "  // (opted out, not a prospect, stated not to the brand, an address our verifier judged invalid) answered now. A\n" +
  "  // refusal asks no writer and is acted on below exactly as the send's refusal was (same date, row and delivery).\n" +
  `  results.send_check = results.channel_plan?.channel === "email" && results.channel_plan?.skipModel !== true && typeof results.channel_plan?.email === "string"\n` +
  `    ? callStep(ctx, "${SEND_CHECK_DOOR}", { service: "email-gateway", method: "POST", path: "/orgs/send-checks", body: (({type: "broadcast", followUp: true, to: results.channel_plan.email})), skipOnRefusalCodes: ${JSON.stringify(SEND_CHECK_REFUSAL_CODES)} }, 0)\n` +
  "    : { ok: false, skipped: true, notCalled: true };\n" +
  "  const CHECK_REFUSED: boolean = results.send_check?.skipped === true && results.send_check?.notCalled !== true;\n" +
  "  if (CHECK_REFUSED) results.channel_plan = { ...results.channel_plan, skipModel: true };\n";

const REFUSED_BRANCH =
  "  if (CHECK_REFUSED) {\n" +
  "    // The check refused the email: no writer is asked; the refusal is read below as the send's own.\n" +
  '    results.finalize = { decision: "write", channel: "email", to: results.channel_plan.email, skipWhatsapp: true, skipEmail: true, whatsappBody: {} };\n' +
  "  } else if (results.channel_plan?.skipModel === true) {\n";

const REFUSAL_AS_SEND = "  if (CHECK_REFUSED) results.send_email = results.send_check;\n";

function once(code: string, anchor: string, name: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) throw new Error(`send-check: the stored code holds the ${name} line ${at < 0 ? "nowhere" : "more than once"}: nothing generated`);
  return at;
}

/** The sender's stored code with the check before its writer. Throws when an anchor moved or the check is already in. */
export function addSendCheck(code: string): string {
  if (code.includes(`"${SEND_CHECK_DOOR}"`)) throw new Error("send-check: the stored code already asks the check");
  const A = SEND_CHECK_ANCHORS;
  const plan = once(code, A.channelPlan, "channel plan") + A.channelPlan.length;
  const branch = once(code, A.writerBranch, "writer branch");
  once(code, A.sendEmail, "email send");
  const after = once(code, A.afterSends, "after-sends");
  if (!(plan <= branch && branch < after)) throw new Error("send-check: the stored lines are not in the expected order: nothing generated");
  return (
    code.slice(0, plan) +
    CHECK_LINES +
    code.slice(plan, branch) +
    REFUSED_BRANCH +
    code.slice(branch + A.writerBranch.length, after) +
    REFUSAL_AS_SEND +
    code.slice(after)
  );
}

// ---- the proof on one recorded case ----

export interface RecordedCall {
  name: string;
  args?: unknown;
  answer: { ok: boolean; data: Record<string, unknown> };
}
export interface SenderCase {
  id: string;
  units?: Record<string, unknown>;
  request?: Record<string, unknown> | null;
  tactics?: Record<string, unknown>;
  subject?: string | null;
  day?: number;
  asks?: unknown[];
  calls: RecordedCall[];
  expect?: Record<string, unknown>;
}
export interface Step {
  kind: "vendor" | "ask";
  name: string;
  args: unknown;
}
type End = { kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string };
type RunFn = (
  code: string,
  spec: { subject: string | null; brand: string; day: number; tactics: Record<string, unknown>; request: Record<string, unknown> | null },
  bridge: (op: string, args: unknown[]) => Promise<{ v: unknown } | { stop: string }>,
) => Promise<End>;

/** Doors a refused run no longer calls: what only its writer needed, and the send itself. */
export const SKIPPED_WHEN_REFUSED = [
  "brand.offer.economics",
  "brand.profile",
  "brand.offer.answers",
  "brand.offer.fields",
  "brand.fields",
  "lead.history",
  "lead.relationship",
  "chat.judgment",
  "scraping.page",
  "voice.read",
  "email.send",
];

const json = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

export interface SendCheckComparison {
  /** `refused`: the recorded send was refused on the person; `passed`: an email channel, checked and passing; `unchecked`: no email channel. */
  kind: "refused" | "passed" | "unchecked" | "unfit";
  same: boolean;
  diff: string | null;
  old: { steps: Step[]; end: End };
  next: { steps: Step[]; end: End };
  /** The case restated for the new code: its calls as the new code makes them, the check's answer in place. */
  restated: SenderCase | null;
}

/** The answer the check gives on this record: the send's own refusal when it was one on the person, else a pass. */
export function checkAnswerFromRecord(c: SenderCase): { answer: RecordedCall["answer"]; refused: boolean } {
  const send = c.calls.find((x) => x.name === "email.send");
  const data = (send?.answer?.data ?? {}) as Record<string, unknown>;
  const code = typeof data.code === "string" ? data.code : null;
  if (send && send.answer.ok === false && code && (SEND_CHECK_REFUSAL_CODES as readonly string[]).includes(code)) {
    return { answer: json(send.answer), refused: true };
  }
  const to = ((send?.args as { body?: { to?: unknown } } | undefined)?.body?.to ?? null) as string | null;
  return {
    answer: { ok: true, data: { sendable: true, transport: "instantly", to, verdict: "valid", reused: true, verifiedAt: null } },
    refused: false,
  };
}

/**
 * The stored sender and its checked upgrade on ONE recorded case, every door answered from the record (nothing called,
 * nothing sent), the check answered by what the record's send said about the person. Same = a pass makes the very same
 * calls and asks plus the check, a refusal makes the same calls minus the writer's reads and the send, asks no writer,
 * and both end alike.
 */
export async function compareSendCheckOnCase(
  oldCode: string,
  newCode: string,
  c: SenderCase,
  runScriptFn: RunFn,
  same: (a: unknown, b: unknown) => boolean,
): Promise<SendCheckComparison> {
  const spec = { subject: c.subject ?? null, brand: "replay", day: c.day ?? 0, tactics: c.tactics ?? {}, request: c.request ?? null };
  const units = c.units ?? {};
  const getUnit = (outcome: string): { v: unknown } | { stop: string } =>
    units[outcome] !== undefined ? { v: { id: `${c.id}:${outcome}`, outcome, subject: c.subject ?? "", ageDays: 0, content: json(units[outcome]) } } : { stop: `${outcome} not recorded` };
  const storage = (op: string) => (op.startsWith("storage.") ? { v: null } : null);

  // The stored code, strictly on the record.
  const oldSteps: Step[] = [];
  let next = 0;
  const oldEnd = await runScriptFn(oldCode, spec, async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      oldSteps.push({ kind: "vendor", name, args: json(args[1] ?? null) });
      const rec = c.calls[next];
      if (!rec || rec.name !== name) return { stop: `call ${next + 1}: called ${name}, the record ${rec ? "called " + rec.name : "made no more calls"}` };
      next++;
      return { v: json(rec.answer) };
    }
    if (op === "ask") {
      oldSteps.push({ kind: "ask", name: "ask", args: json(args[0] ?? null) });
      return { v: null };
    }
    if (op === "get") return getUnit(String(args[0]));
    return storage(op) ?? { stop: String(op) };
  });
  const old = { steps: oldSteps, end: oldEnd };
  if (oldEnd.kind === "stopped") return { kind: "unfit", same: false, diff: `the stored code does not replay it: ${oldEnd.reason}`, old, next: { steps: [], end: oldEnd }, restated: null };

  const check = checkAnswerFromRecord(c);
  const newSteps: Step[] = [];
  const restatedCalls: RecordedCall[] = [];
  let cursor = 0;
  const newEnd = await runScriptFn(newCode, spec, async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      const sent = json(args[1] ?? null);
      newSteps.push({ kind: "vendor", name, args: sent });
      if (name === SEND_CHECK_DOOR) {
        restatedCalls.push({ name, args: sent ?? undefined, answer: json(check.answer) });
        return { v: json(check.answer) };
      }
      // A refused run skips what only its writer needed: those recorded calls are passed over, nothing else.
      while (check.refused && c.calls[cursor] && c.calls[cursor]!.name !== name && SKIPPED_WHEN_REFUSED.includes(c.calls[cursor]!.name)) cursor++;
      const rec = c.calls[cursor];
      if (!rec || rec.name !== name) return { stop: `call ${cursor + 1}: called ${name}, the record ${rec ? "called " + rec.name : "made no more calls"}` };
      cursor++;
      restatedCalls.push({ name, ...(rec.args !== undefined ? { args: json(rec.args) } : {}), answer: json(rec.answer) });
      return { v: json(rec.answer) };
    }
    if (op === "ask") {
      newSteps.push({ kind: "ask", name: "ask", args: json(args[0] ?? null) });
      return { v: null };
    }
    if (op === "get") return getUnit(String(args[0]));
    return storage(op) ?? { stop: String(op) };
  });
  const nxt = { steps: newSteps, end: newEnd };
  const checked = newSteps.some((s) => s.name === SEND_CHECK_DOOR);
  const kind: SendCheckComparison["kind"] = !checked ? "unchecked" : check.refused ? "refused" : "passed";

  let diff: string | null = null;
  if (newEnd.kind === "stopped") diff = `the upgrade does not replay it: ${newEnd.reason}`;
  if (diff === null && check.refused && !checked) diff = "the record's send was refused on the person, the upgrade asked no check";
  // What the old run made, minus what the upgrade no longer makes, must be exactly what the upgrade made minus the check.
  const want = kind === "refused" ? oldSteps.filter((s) => s.kind === "vendor" && !SKIPPED_WHEN_REFUSED.includes(s.name)) : oldSteps;
  const got = newSteps.filter((s) => s.name !== SEND_CHECK_DOOR);
  if (diff === null && kind === "refused" && newSteps.some((s) => s.kind === "ask")) diff = "a refused run asked its writer";
  if (diff === null && want.length !== got.length) diff = `the stored code made ${want.length} calls${kind === "refused" ? " (minus the writer's)" : ""}, the upgrade ${got.length}`;
  for (let i = 0; diff === null && i < want.length; i++) {
    const x = want[i]!;
    const y = got[i]!;
    if (x.kind !== y.kind || x.name !== y.name) diff = `call ${i + 1}: the stored code made ${x.kind} ${x.name}, the upgrade ${y.kind} ${y.name}`;
    else if (!same(x.args, y.args)) diff = `call ${i + 1} ${x.name}: not the same request`;
  }
  // The check asks for the very address the send went to.
  if (diff === null && checked) {
    const sentTo = (oldSteps.find((s) => s.name === "email.send")?.args as { body?: { to?: unknown } } | undefined)?.body?.to;
    const checkedTo = (newSteps.find((s) => s.name === SEND_CHECK_DOOR)?.args as { body?: { to?: unknown } } | undefined)?.body?.to;
    if (sentTo !== undefined && sentTo !== checkedTo) diff = "the check asked another address than the send's";
  }
  if (diff === null && !same(oldEnd, newEnd)) diff = `not the same end (${oldEnd.kind} / ${newEnd.kind})`;

  const restated: SenderCase | null =
    diff === null
      ? {
          ...c,
          calls: restatedCalls,
          ...(c.asks !== undefined ? { asks: kind === "refused" ? [] : c.asks } : {}),
          ...(kind === "refused" && c.units ? { units: Object.fromEntries(Object.entries(c.units).filter(([k]) => k !== "message_written")) } : {}),
        }
      : null;
  return { kind, same: diff === null, diff, old, next: nxt, restated };
}
