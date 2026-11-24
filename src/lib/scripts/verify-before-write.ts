/**
 * VERIFY-BEFORE-WRITE-1124 (ENGINE-GET-ASK-1123 step 3b): a cold email sender looks at the address BEFORE it asks its
 * writer.
 *
 * The address was verified only inside the send (email-gateway -> instantly-service's door -> apollo-service), after
 * the message was written: liliane@cfhmc.com, 2026-11-22 00:11 UTC, written at 00:11:31 (a writer + a model run),
 * verified at 00:11:35. An address the door refuses cost a written message for nothing.
 *
 * The four senders now, right after their person is served and before any read for the writer:
 *  1. READ the address' Units from their Provider (`ctx.get("email_found", ...)`, apollo-service's `listEmailFoundUnits`):
 *     the decisive verdicts not older than the Script's own window, tactic `verdictMaxAgeDays` (data; 30 = the fleet's
 *     rule today);
 *  2. none in the window = a new one through apollo's verifying door (`apollo.email.verifications`, on the run,
 *     `maxVerdictAgeDays` = the same window);
 *  3. a verdict apollo calls deliverable = the Script declares the Unit it reused consumed (`email_checked` on the
 *     subject apollo states; a null subject or a verdict the run just paid for = nothing consumed) and goes on;
 *  4. any other verdict = the SEND's own door is asked (`email.send_check`, free on a held verdict): it passes what the
 *     send passes (a decisive catch_all or unknown) and the run goes on; it refuses what the send refuses, with the
 *     send's own code (`email_not_verified`), recorded where the send records it (so lead-service sets the person aside
 *     exactly as after a refused send), and the run ends as it ended on the send's refusal: no writer asked.
 * The Script holds no list of verdicts: which ones mail leaves for stays the door's one rule. The send still runs its
 * own gate. No tactic stated = the stored code byte for byte in what it calls (no read, no verification before writing).
 *
 * Applied to the STORED code by anchored edits (`addVerifyBeforeWrite`, an UPGRADE of each dynasty); a moved anchor =
 * nothing generated. A port's recorded cases are restated under the rule (`restateCaseForVerifyBeforeWrite`).
 *
 * INTRO-VERIFY-BEFORE-WRITE-1124: the three intro first emails (`email_sent/dy_intro_*`, one code) take the SAME look,
 * the same helper, through their own shape (`INTRO_FIRST_EMAIL_SHAPE`): after their free "already in conversation"
 * read and before anything paid (the reader's research, the match, the writer). A refusal ends the run as their own
 * send's refusal does (`{unmade: "<code>: <the door's words>", again: true}`). A staff test (`testRecipient`) or a dry
 * run sends nothing to the reader, so it asks nothing about their address.
 */

export const VERIFY_BEFORE_WRITE_SENDERS = [
  { outcome: "email_sent", dynasty: "dy_cold_email" },
  { outcome: "email_sent", dynasty: "dy_cold_email_site" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_sender_client_brand" },
] as const;

/** The tactic: the oldest decisive verdict (days) the Script writes on. Absent = no look before writing. */
export const VERDICT_WINDOW_TACTIC = "verdictMaxAgeDays";
/** Today's fleet rule (instantly-service's door reuses a verdict under 30 days), stated on each dynasty as data. */
export const FLEET_VERDICT_WINDOW_DAYS = 30;

export const EMAIL_FOUND_OUTCOME = "email_found";
export const EMAIL_FOUND_READ = `provider:${EMAIL_FOUND_OUTCOME}`;
export const VERIFY_DOOR = "apollo.email.verifications";
export const SEND_CHECK_DOOR = "email.send_check";
/** The send's refusal on a verdict (instantly-service `EMAIL_NOT_VERIFIED_REFUSAL_CODE`), as recorded cases hold it. */
export const VERDICT_REFUSAL_CODE = "email_not_verified";

const MARK = "VERIFY-BEFORE-WRITE-1124";

/** The stored sender's own line the look goes in front of (found exactly once, else nothing is generated). */
const THREAD_ANCHOR = '  const t = ctx.vendor.call("crm.person.thread", {\n';

const LOOK_LINES =
  `  // ${MARK}: the address is looked at before anything is read or written for it (tactic verdictMaxAgeDays).\n` +
  "  // An address the send's door refuses ends the run here as it ended on the send's refusal, no writer asked.\n" +
  "  const addressRefusal = refusedBeforeWriting(ctx, tactics, address, req.now, !!named);\n" +
  "  if (addressRefusal) return named ? { unmade: addressRefusal } : { unmade: addressRefusal, again: true };\n";

/** How a sender states the send's refusal: its bare code (cold senders), or its code and the door's words (intros). */
export type RefusalForm = "code" | "codeAndWords";

/** The stored code's own lines a look is anchored on, and the look itself: one per family of senders, the helper shared. */
export interface LookShape {
  /** The stored line the look goes in front of (found exactly once, else nothing is generated). */
  anchor: string;
  /** What the anchor is, in the error a moved anchor raises. */
  anchorName: string;
  /** Lines the look leans on, each stated before the anchor. */
  needs: string[];
  /** The stored branch the look's refusal reproduces (found exactly once, anywhere), when the shape names one. */
  reproduces?: string;
  look: string;
  refusal: RefusalForm;
}

const REFUSAL_RETURN: Record<RefusalForm, string> = {
  code: "code",
  codeAndWords: 'code + ": " + String(check.data.body?.error ?? check.data.error ?? "").slice(0, 300)',
};

const helper = (refusal: RefusalForm) => `

/**
 * ${MARK}: tactic \`verdictMaxAgeDays\`. The address' decisive verdict not older than that window, read from
 * its Provider, else asked of apollo's verifying door on this run. Deliverable = the Unit reused is declared consumed
 * and the run goes on (null). Any other verdict = the send's own door says: a pass goes on, a refusal is returned (its
 * code, the send's own). No tactic = null, nothing asked.
 */
function refusedBeforeWriting(ctx: any, tactics: any, address: string, now: string, namedPerson: boolean): string | null {
  const days = tactics?.verdictMaxAgeDays;
  if (days === undefined || days === null) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 0 || days > 3650) throw new Error("tactic verdictMaxAgeDays is a whole number of days, 0 to 3650");
  const email = address.toLowerCase();
  const since = new Date(Date.parse(now) - days * 86400000).toISOString();
  const read = ctx.get("email_found", { route: "listEmailFoundUnits", query: { emails: email, decisive: "true", since, limit: 1 } });
  if (!read.ok) throw new Error("email_found (read): " + String(read.data.error));
  const units: any[] = Array.isArray(read.data.units) ? read.data.units : [];
  const held = units.find((u) => u && typeof u.email === "string" && u.email.toLowerCase() === email && u.decisive === true) ?? null;
  let deliverable: boolean;
  if (held) {
    deliverable = held.deliverable === true;
  } else {
    const v = ctx.vendor.call("apollo.email.verifications", { body: { emails: [email], maxVerdictAgeDays: days, source: "sender-before-write" } });
    if (!v.ok) throw new Error("apollo.email.verifications: " + String(v.data.error));
    const results: any[] = Array.isArray(v.data.results) ? v.data.results : [];
    const fresh = results.find((r) => r && typeof r.email === "string" && r.email.toLowerCase() === email);
    if (!fresh || typeof fresh.verdict !== "string") throw new Error("apollo.email.verifications answered no verdict for the address");
    deliverable = fresh.deliverable === true;
  }
  if (!deliverable) {
    // Not a verdict apollo calls deliverable: the send's own door decides (and records its refusal, as the send does).
    const check = ctx.vendor.call("email.send_check", { body: { type: "broadcast", to: address } });
    if (!check.ok) {
      const code = typeof check.data.code === "string" ? check.data.code : typeof check.data.body?.code === "string" ? check.data.body.code : typeof check.data.body?.details?.code === "string" ? check.data.body.details.code : null;
      const status = Number(check.data.status);
      if (code && (status === 409 || (namedPerson && status >= 400 && status < 500))) return ${REFUSAL_RETURN[refusal]};
      throw new Error("email.send_check: " + String(check.data.error));
    }
  }
  // The Unit this run reused is one it used: declared consumed on the subject its Provider states (none stated = none).
  const subject = held && held.subject && typeof held.subject.subjectService === "string" && typeof held.subject.subjectId === "string" ? held.subject : null;
  if (subject) ctx.consume("email_checked", { service: subject.subjectService, id: subject.subjectId });
  return null;
}
`;

/** The four cold email senders: the look in front of their person thread read, the refusal their send's own (its code). */
export const COLD_SENDER_SHAPE: LookShape = {
  anchor: THREAD_ANCHOR,
  anchorName: "person thread",
  needs: ["  const address = ", "const named = ", "const tactics = ", "const req = "],
  look: LOOK_LINES,
  refusal: "code",
};

export const INTRO_FIRST_EMAILS = [
  { outcome: "email_sent", dynasty: "dy_intro_open" },
  { outcome: "email_sent", dynasty: "dy_intro_lead_to_lead" },
  { outcome: "email_sent", dynasty: "dy_intro_client_to_lead" },
] as const;

/**
 * The intro first emails (one code): the look after their free "already in conversation" read, in front of the first
 * thing they pay for about the reader (their research). Their send's own refusal is `{unmade: code + ": " + words,
 * again: true}` on a 409 naming a code: the look ends the run the same way. Nothing is asked on a staff test or a dry
 * run (no email goes to the reader, and the door's check records its refusal on a real person).
 */
export const INTRO_FIRST_EMAIL_SHAPE: LookShape = {
  anchor: "  reader.research = research(ctx, reader, brandId, campaignId);\n",
  anchorName: "reader research",
  needs: ["  const now = s(R.now);", "  const t: any = ", "  const testRecipient = ", "  const dryRun = ", "  const reader: any = personOf(served.lead);"],
  reproduces: '    if (code && Number(dd.status) === 409) return { unmade: code + ": " + String(dd.body?.error ?? dd.error ?? "").slice(0, 300), again: true };',
  look:
    `  // ${MARK}: the reader's address is looked at before anything is paid for them (tactic verdictMaxAgeDays).\n` +
    "  // An address the send's door refuses ends the run here as it ends on the send's refusal: no research, no writer.\n" +
    "  const addressRefusal = testRecipient || dryRun ? null : refusedBeforeWriting(ctx, t, reader.email, now, false);\n" +
    "  if (addressRefusal) return { unmade: addressRefusal, again: true };\n",
  refusal: "codeAndWords",
};

/**
 * The stored sender's code with the look before its writer (`shape`: the cold senders' unless stated). Throws when the
 * anchor moved or the look is already in.
 */
export function addVerifyBeforeWrite(code: string, shape: LookShape = COLD_SENDER_SHAPE): string {
  if (code.includes(MARK)) throw new Error("verify-before-write: the stored code already looks at the address before writing");
  const at = code.indexOf(shape.anchor);
  if (at < 0 || code.indexOf(shape.anchor, at + 1) >= 0) throw new Error(`verify-before-write: the ${shape.anchorName} line is found ${at < 0 ? "nowhere" : "more than once"}: nothing generated`);
  for (const needs of shape.needs) {
    const i = code.indexOf(needs);
    if (i < 0 || i > at) throw new Error(`verify-before-write: the stored code does not state \`${needs.trim()}\` before the ${shape.anchorName}: nothing generated`);
  }
  if (shape.reproduces !== undefined) {
    const r = code.indexOf(shape.reproduces);
    if (r < 0 || code.indexOf(shape.reproduces, r + 1) >= 0) throw new Error(`verify-before-write: the send's own refusal branch the look reproduces is found ${r < 0 ? "nowhere" : "more than once"}: nothing generated`);
  }
  return code.slice(0, at) + shape.look + code.slice(at) + helper(shape.refusal);
}

/** The tactics: the window stated as data (a window the dynasty already states is kept). */
export function verifyBeforeWriteTactics(tactics: Record<string, unknown>): Record<string, unknown> {
  return typeof tactics[VERDICT_WINDOW_TACTIC] === "number" ? { ...tactics } : { ...tactics, [VERDICT_WINDOW_TACTIC]: FLEET_VERDICT_WINDOW_DAYS };
}

// ---- a port's recorded cases, restated under the rule ----

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
type End = { kind: "done"; result: unknown } | { kind: "error"; message: string } | { kind: "stopped"; reason: string };
type RunFn = (
  code: string,
  spec: { subject: string | null; brand: string; day: number; tactics: Record<string, unknown>; request: Record<string, unknown> | null },
  bridge: (op: string, args: unknown[]) => Promise<{ v: unknown } | { stop: string }>,
) => Promise<End>;

export type Restated =
  /** The case never reaches an address (nobody served): it stands as recorded. */
  | { kind: "unchanged"; case: SenderCase }
  /** Its send went out: the read answers the verdict the send's door accepted; every other call as recorded. */
  | { kind: "sent"; case: SenderCase }
  /** Its send was refused on the verdict: the read and the door's refusal, nothing after (no writer, no send). */
  | { kind: "refused"; case: SenderCase }
  /** What the address' verdict was is not on the record: the case cannot be restated truthfully. */
  | { kind: "excluded"; reason: string }
  /** The upgrade does not run on the record as it must: nothing may be stored. */
  | { kind: "different"; reason: string };

const json = <T,>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

function refusalCodeOf(send: RecordedCall): string | null {
  const d = send.answer.data as { code?: unknown; body?: { code?: unknown; details?: { code?: unknown } } };
  return typeof d.code === "string" ? d.code : typeof d.body?.code === "string" ? d.body.code : typeof d.body?.details?.code === "string" ? d.body.details.code : null;
}

/**
 * What the Provider read answers on this record. A record holds no verification id, date or subject: it holds what the
 * send's door did with the address. A send that went out = a decisive verdict mail leaves for stood (stated as the one
 * apollo calls deliverable; unknown fields null, no subject, so nothing is consumed). A send refused on the verdict =
 * that verdict, as the refusal states it. Anything else = not on the record.
 */
export function readAnswerFromRecord(c: SenderCase, email: string): { answer: RecordedCall["answer"]; refused: boolean } | { excluded: string } {
  const send = c.calls.find((x) => x.name === "email.send");
  if (!send) return { excluded: "the record reaches an address and holds no send: what its verdict was is not recorded" };
  const unit = (verdict: unknown, verifiedAt: unknown, deliverable: boolean) => ({
    verificationId: null,
    email,
    verdict: typeof verdict === "string" ? verdict : null,
    decisive: true,
    deliverable,
    step: null,
    verifier: null,
    verifiedAt: typeof verifiedAt === "string" ? verifiedAt : null,
    ageDays: null,
    source: null,
    subject: null,
  });
  const page = (u: unknown) => ({ ok: true, data: { units: [u], nextBefore: null, hasMore: false } });
  if (send.answer.ok) return { answer: page(unit("valid", null, true)), refused: false };
  const code = refusalCodeOf(send);
  if (code !== VERDICT_REFUSAL_CODE) return { excluded: `the record's send was refused for another reason than the verdict (${code ?? "no code"}): what the address' verdict was is not recorded` };
  const body = ((send.answer.data.body ?? send.answer.data) as Record<string, unknown>) ?? {};
  return { answer: page(unit(body.verdict, body.verifiedAt, false)), refused: true };
}

/**
 * ONE recorded case of a sender, as the upgraded code runs it: every recorded call answered from the record in order,
 * the Provider read answered by what the record's send says about the address (`readAnswerFromRecord`), the door's
 * check by the send's own recorded refusal. Nothing is called, nothing is sent. `tactics` = the upgraded version's
 * (the window), under the case's own.
 */
export async function restateCaseForVerifyBeforeWrite(newCode: string, c: SenderCase, tactics: Record<string, unknown>, run: RunFn): Promise<Restated> {
  const calls: RecordedCall[] = [];
  const asked: unknown[] = [];
  const gotten = new Map<string, number>();
  const store = new Map<string, unknown>();
  let cursor = 0;
  let read: { refused: boolean } | null = null;
  let excluded: string | null = null;
  const units = (c.units ?? {}) as Record<string, unknown>;
  const send = c.calls.find((x) => x.name === "email.send");
  const end = await run(newCode, { subject: c.subject ?? null, brand: "replay", day: c.day ?? 0, tactics: { ...tactics, ...(c.tactics ?? {}) }, request: c.request ?? null }, async (op, args) => {
    if (op === "get" && args.length > 1) {
      if (String(args[0]) !== EMAIL_FOUND_OUTCOME) return { stop: `read ${String(args[0])} from its Provider, which no record holds` };
      const email = String(((args[1] as { query?: { emails?: unknown } } | null)?.query?.emails) ?? "");
      const from = readAnswerFromRecord(c, email);
      if ("excluded" in from) {
        excluded = from.excluded;
        return { stop: "excluded" };
      }
      read = { refused: from.refused };
      calls.push({ name: EMAIL_FOUND_READ, args: json(args[1] ?? {}), answer: from.answer });
      return { v: json(from.answer) };
    }
    if (op === "get" || (op === "ask" && typeof args[0] === "string")) {
      if (op === "ask") asked.push(json(args[1] ?? {}));
      const outcome = String(args[0]);
      const held = units[outcome];
      if (held === undefined) return { stop: `asked for ${outcome}, which the case does not hold` };
      const n = gotten.get(outcome) ?? 0;
      gotten.set(outcome, n + 1);
      const list = Array.isArray(held) ? held : [held];
      return { v: { id: `${c.id}:${outcome}:${n}`, outcome, subject: c.subject ?? "", ageDays: 0, content: json(list[Math.min(n, list.length - 1)]) } };
    }
    if (op === "ask") {
      asked.push(json(args[0] ?? null));
      return { v: null };
    }
    if (op === "consume") return { v: null };
    if (op === "vendor") {
      const name = String(args[0]);
      if (name === VERIFY_DOOR) return { stop: "asked for a new verification, which no record holds" };
      if (name === SEND_CHECK_DOOR) {
        if (!read?.refused || !send) return { stop: "asked the send's check on an address the record's send accepted" };
        calls.push({ name, args: json(args[1] ?? {}), answer: json(send.answer) });
        return { v: json(send.answer) };
      }
      const rec = c.calls[cursor];
      if (!rec || rec.name !== name) return { stop: `call ${cursor + 1}: called ${name}, the record ${rec ? "called " + rec.name : "made no more calls"}` };
      cursor++;
      calls.push(json(rec));
      return { v: json(rec.answer) };
    }
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set" || (op === "storage.claim" && !store.has(key))) store.set(key, args[2] ?? null);
    if (op === "storage.set") return { v: null };
    if (op === "storage.claim") return { v: store.get(key) ?? null };
    if (op === "storage.delete") {
      store.delete(key);
      return { v: null };
    }
    if (op === "storage.count") return { v: [...store.keys()].filter((k) => k.startsWith(`${String(args[0])}\u0000`)).length };
    return { stop: `${String(op)} asked` };
  });
  if (excluded !== null) return { kind: "excluded", reason: excluded };
  if (end.kind === "stopped") return { kind: "different", reason: `the upgrade does not run on the record: ${end.reason}` };
  const seen = read as { refused: boolean } | null;
  if (!seen) {
    if (cursor !== c.calls.length) return { kind: "different", reason: `the upgrade made ${cursor} of the record's ${c.calls.length} calls` };
    return { kind: "unchanged", case: c };
  }
  if (seen.refused) {
    // The run ended before its writer: the record's later calls (the reads for the writer, the send) are not made.
    const made = (end.kind === "done" ? (end.result as { unmade?: unknown } | null)?.unmade : null) ?? null;
    if (made !== VERDICT_REFUSAL_CODE) return { kind: "different", reason: `a send refused on the verdict did not end ${VERDICT_REFUSAL_CODE} before the writer` };
    if (calls.some((x) => x.name === "email.send")) return { kind: "different", reason: "a refused address was still sent to" };
  } else if (cursor !== c.calls.length) {
    return { kind: "different", reason: `the upgrade made ${cursor} of the record's ${c.calls.length} calls` };
  }
  return { kind: seen.refused ? "refused" : "sent", case: { ...c, calls, ...(c.asks !== undefined ? { asks: asked } : {}) } };
}
