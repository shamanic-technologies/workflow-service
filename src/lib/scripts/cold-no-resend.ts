/**
 * COLD-COPY-RESEND-1126 (owner, 2026-11-26: a person we already emailed never receives an email that was already sent
 * to them; their next message is newly written). Prod 2026-11-26 10:03-10:43 UTC: 79 Living Vital prospects received
 * their FIRST cold email again, word for word, as « Re: <same subject> » in the same thread.
 *
 * Cause: content-generation answers a writer's materials with `existing` when it already holds an email for that lead on
 * that campaign (one email per (org, campaign, lead): made for a person written to but never sent to, so a re-serve
 * does not pay twice). The cold sender then has content-generation answer that stored email and sends it. Since
 * PERSON-ALREADY-EMAILED-1125 the sender sends to a person whose thread holds our email as a follow-up in that thread,
 * so the stored email, the very one they already received, went out again.
 *
 * The rule, in the sender's own code: when the writer answers `existing` AND the person's thread already holds an email
 * WE sent them, nothing is sent: the run ends `unmade` naming why. The person is served again later; a newly written
 * next message needs content-generation to write a new one for a person who already holds our email (its need).
 * Never a check on the writer's text. A person we never emailed, or a writer that wrote: byte for byte. Anchored edit
 * of the STORED code (versions carrying PERSON-ALREADY-EMAILED-1125); a moved anchor = nothing generated.
 */
const MARK = "COLD-COPY-RESEND-1126";
const ANCHOR = "  const existing = got.content.existing === true;";
export const ALREADY_WRITTEN_CODE = "already_written_for_this_person";

const GUARD = `
  // ${MARK}: the stored email content-generation hands back for this lead, to a person whose thread already holds our
  // email, is (or may be) the one they already received: never sent again; their next message is newly written.
  if (existing && emailedBefore) {
    return { unmade: "${ALREADY_WRITTEN_CODE}: an email was already written for " + String(lead.email) + " on this campaign and their thread already holds our email; it is never sent again" };
  }`;

export function addColdNoResend(code: string): string {
  if (code.includes(MARK)) throw new Error("cold no resend: already in the code");
  if (code.split(ANCHOR).length !== 2) throw new Error("cold no resend: the anchor is not found exactly once");
  if (!code.includes("const emailedBefore")) throw new Error("cold no resend: this version does not read whether the thread holds our email");
  return code.replace(ANCHOR, ANCHOR + GUARD);
}

interface CaseCall {
  name: string;
  args?: Record<string, unknown>;
  answer: { ok: boolean; data: Record<string, unknown> };
}

function threadHoldsOurEmail(answer: CaseCall["answer"] | undefined): boolean {
  if (!answer || answer.ok !== true) return false;
  const items = (answer.data as { items?: unknown }).items;
  return Array.isArray(items) && items.some((i: any) => i && i.kind === "message" && i.channel === "email" && i.direction === "outbound");
}

/**
 * A recorded case restated under the rule: a writer answer `existing` for a person whose recorded thread holds our
 * email = the run ends before `content.generate` (those calls and every later one dropped), its end = `endOf` the
 * unmade answer (the caller computes it with the runner's own `endRunBodyOf`). Every other case as recorded.
 */
export function restateCaseForColdNoResend<C extends { calls: CaseCall[]; units?: Record<string, any>; expect: Record<string, unknown> }>(
  c: C,
  endOf: (unmade: string, c: C) => Record<string, unknown>,
): { case: C; changed: boolean } {
  const copy = JSON.parse(JSON.stringify(c)) as C;
  const written = copy.units?.message_written;
  const units = Array.isArray(written) ? written : written ? [written] : [];
  const existing = units.some((u: any) => u && (u.existing === true || u.content?.existing === true));
  const thread = copy.calls.find((x) => x.name === "crm.person.thread");
  if (!existing || !threadHoldsOurEmail(thread?.answer)) return { case: copy, changed: false };
  const at = copy.calls.findIndex((x) => x.name === "content.generate");
  if (at < 0) return { case: copy, changed: false };
  copy.calls = copy.calls.slice(0, at);
  copy.expect = { end: endOf(ALREADY_WRITTEN_CODE, copy) };
  return { case: copy, changed: true };
}

/**
 * COLD-COPY-RESEND-1126, the clean half (content-generation v0.36.68, `alreadyEmailed`): a person whose thread already
 * holds our email gets a NEWLY written next message. The sender's generation body (handed to its writer, which passes
 * it to content-generation's materials AND /generate) states `alreadyEmailed: true` and an `idempotencyKey` per sender
 * run (a retry of the same send gets the same new email, never a second one): content-generation then never answers the
 * lead's stored email and stores the new one as its own row. The writer already reads their whole thread
 * (`leadRelationship` in its variables). The guard above stays: `existing` for such a person is still never sent. A
 * person we never emailed: byte for byte. Anchored edit of the STORED code carrying the guard.
 */
const NEXT_MARK = "COLD-COPY-RESEND-1126 next email";
const BODY_ANCHOR = "    brief: req.brief ?? undefined,\n    variables,\n  };\n";
const NEXT_BODY = `  // ${NEXT_MARK}: their thread holds our email = content-generation writes a NEW one (never the lead's stored email),
  // keyed on this run so a retry of the same send gets the same new email.
  if (emailedBefore) {
    genBody.alreadyEmailed = true;
    genBody.idempotencyKey = "cold-next-email:" + String(req.runId ?? lead.leadId + ":" + String(req.now ?? ""));
  }
`;

export function addColdNextEmail(code: string): string {
  if (code.includes(NEXT_MARK)) throw new Error("cold next email: already in the code");
  if (!code.includes(MARK)) throw new Error("cold next email: this version does not carry the no-resend guard");
  if (code.split(BODY_ANCHOR).length !== 2) throw new Error("cold next email: the anchor is not found exactly once");
  return code.replace(BODY_ANCHOR, BODY_ANCHOR + NEXT_BODY);
}

/**
 * A recorded case restated under the next-email edit: a person whose recorded thread holds our email = the writer's ask
 * (`asks[*].units.generation_request.content.body`) states `alreadyEmailed: true` and the key the code builds from the
 * case's Request (`runId`, else lead + clock). Every other case, and every recorded answer, as recorded.
 */
export function restateCaseForColdNextEmail<C extends { calls: CaseCall[]; request?: Record<string, any> | null; asks?: unknown }>(c: C): { case: C; changed: boolean } {
  const copy = JSON.parse(JSON.stringify(c)) as C;
  const thread = copy.calls.find((x) => x.name === "crm.person.thread");
  if (!threadHoldsOurEmail(thread?.answer) || !Array.isArray(copy.asks)) return { case: copy, changed: false };
  let changed = false;
  for (const ask of copy.asks as any[]) {
    const body = ask?.units?.generation_request?.content?.body;
    if (!body || typeof body !== "object") continue;
    const req = (copy.request ?? {}) as Record<string, any>;
    body.alreadyEmailed = true;
    body.idempotencyKey = "cold-next-email:" + String(req.runId ?? body.leadId + ":" + String(req.now ?? ""));
    changed = true;
  }
  return { case: copy, changed };
}
