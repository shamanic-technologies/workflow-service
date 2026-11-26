/**
 * PERSON-ALREADY-EMAILED-1125 (owner rule FOLLOWUP-JIT 2026-11-07: a person the brand already emailed gets a follow-up
 * in their thread, never a new cold introduction). A cold email sender (`email_sent/dy_cold_email*`) is handed people
 * lead-service serves FIRST when their follow-up is due (piece A of PLAN-RECURSIVE-PER-ENGINE-1124-WF3), and its
 * writer reads their whole thread; yet the send went out as a BROADCAST, a new thread with the writer's subject
 * (prod, 7 days to 2026-11-25: 695 of 1,923 sends of a client's per-pipe unit under a new subject from a new mailbox).
 *
 * The fix is the send's own flag: when the person's thread (crm-service, the read the sender already makes) holds an
 * email WE sent them, the send states `followUp: true`, the same door the follow-up sender uses: email-gateway routes
 * it into the thread they wrote in last (Gmail) else instantly-service continues the brand's own thread, from the
 * mailbox that holds it, under « Re: <its subject> ». Which mailbox and what happens when it cannot send any more is
 * instantly-service's (it refuses a racing follow-up `brand_sequence_queued`, a named 409 this sender already ends on
 * as a normal run). A person we never emailed: the send is byte for byte as before. Anchored edit of the STORED
 * code; a moved anchor = nothing generated.
 */
const MARK = "PERSON-ALREADY-EMAILED-1125";
const THREAD_ANCHOR = "  const timeline = t.ok ? t.data : { ok: false, status: t.data.status, error: t.data.error };";
const SEND_ANCHOR = "      ...(signature !== undefined ? { signature } : {}),";

const EMAILED_BEFORE = `
  // ${MARK}: an email WE sent them is in their thread = this email continues it (followUp), never a new thread.
  const emailedBefore = Array.isArray((timeline as any).items) && (timeline as any).items.some((i: any) => i && i.kind === "message" && i.channel === "email" && i.direction === "outbound");`;

export function addColdSenderThread(code: string): string {
  if (code.includes(MARK)) throw new Error("cold sender thread: already in the code");
  for (const anchor of [THREAD_ANCHOR, SEND_ANCHOR]) {
    if (code.split(anchor).length !== 2) throw new Error("cold sender thread: an anchor is not found exactly once: " + anchor.trim().slice(0, 60));
  }
  return code
    .replace(THREAD_ANCHOR, THREAD_ANCHOR + EMAILED_BEFORE)
    .replace(SEND_ANCHOR, SEND_ANCHOR + "\n      ...(emailedBefore ? { followUp: true } : {}),");
}

/** The four live cold email senders this edit upgrades. */
export const COLD_SENDER_THREAD_SENDERS = [
  { outcome: "email_sent", dynasty: "dy_cold_email" },
  { outcome: "email_sent", dynasty: "dy_cold_email_site" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_sender_client_brand" },
] as const;

interface CaseCall {
  name: string;
  args?: Record<string, unknown>;
  answer: { ok: boolean; data: Record<string, unknown> };
}

/** Does a recorded thread answer hold an email we sent them (the same predicate the upgraded code reads)? */
function threadHoldsOurEmail(answer: CaseCall["answer"] | undefined): boolean {
  if (!answer || answer.ok !== true) return false;
  const items = (answer.data as { items?: unknown }).items;
  return Array.isArray(items) && items.some((i: any) => i && i.kind === "message" && i.channel === "email" && i.direction === "outbound");
}

/**
 * A recorded case of a cold sender restated under the rule: when the person's recorded thread holds an email we sent
 * them, the recorded send states `followUp: true` (answered as recorded); every other call as recorded. Returns
 * `changed` so a caller counts what moved.
 */
export function restateCaseForColdSenderThread<C extends { calls: CaseCall[] }>(c: C): { case: C; changed: boolean } {
  const copy = JSON.parse(JSON.stringify(c)) as C;
  const thread = copy.calls.find((x) => x.name === "crm.person.thread");
  const send = copy.calls.find((x) => x.name === "email.send");
  if (!send || !threadHoldsOurEmail(thread?.answer)) return { case: copy, changed: false };
  const args = (send.args ?? {}) as { body?: Record<string, unknown> };
  if (!args.body || typeof args.body !== "object") throw new Error("cold sender thread: a recorded send states no body");
  args.body = { ...args.body, followUp: true };
  send.args = args as Record<string, unknown>;
  return { case: copy, changed: true };
}

/**
 * PERSON-ALREADY-EMAILED-1125, the envelope the cold writer reads (owner 2026-11-26 « B is great »: a follow-up whose
 * thread mailbox no longer sends still goes, as a new email from another mailbox). When the person's thread holds an
 * email WE sent them, the relationship lines handed to the writer (`leadRelationship.lines`) end on ONE fact line: the
 * email continues that thread while its mailbox sends, else arrives as a new email from someone of our team. Which one
 * is instantly-service's at send, unknown before writing: the writer is told both, never a guess. No email of ours in
 * the thread = byte for byte.
 */
const ENVELOPE_MARK = "PERSON-ALREADY-EMAILED-1125 envelope";
const NO_MESSAGE_ANCHOR = '  if (threadState === "read" && !talked) lines.push("No message was ever exchanged with them on record.");';
export const ENVELOPE_LINE =
  "Our team already emailed this person. This email continues that thread when the mailbox of that thread still sends; otherwise it arrives as a new email from someone of our team they have not heard from yet. Write it so it reads right either way: our team following up on our earlier notes, never one person's own promise or memory, never a re-introduction of us, never \"Re:\" typed in the subject.";

export function addColdSenderEnvelope(code: string): string {
  if (code.includes(ENVELOPE_MARK)) throw new Error("cold sender envelope: already in the code");
  if (code.split(NO_MESSAGE_ANCHOR).length !== 2) throw new Error("cold sender envelope: the anchor is not found exactly once");
  return code.replace(
    NO_MESSAGE_ANCHOR,
    NO_MESSAGE_ANCHOR +
      `\n  // ${ENVELOPE_MARK}: an email of ours in their thread = the writer is told the envelope it writes in.` +
      `\n  if (messages.some((i: any) => i.channel === "email" && i.direction === "outbound")) lines.push(${JSON.stringify(ENVELOPE_LINE)});`,
  );
}

/** A recorded case restated under the envelope line: every asked `leadRelationship` whose thread holds our email gains the line. */
export function restateCaseForColdSenderEnvelope<C extends { calls: CaseCall[]; asks?: unknown }>(c: C): { case: C; changed: boolean } {
  const copy = JSON.parse(JSON.stringify(c)) as C;
  const thread = copy.calls.find((x) => x.name === "crm.person.thread");
  if (!threadHoldsOurEmail(thread?.answer) || copy.asks === undefined) return { case: copy, changed: false };
  let changed = false;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    const rel = o.leadRelationship as { lines?: unknown } | undefined;
    if (rel && typeof rel === "object" && Array.isArray(rel.lines)) {
      rel.lines.push(ENVELOPE_LINE);
      changed = true;
    }
    Object.values(o).forEach(walk);
  };
  walk(copy.asks);
  return { case: copy, changed };
}
