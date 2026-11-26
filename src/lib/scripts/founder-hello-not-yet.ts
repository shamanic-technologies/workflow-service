/**
 * HELLO-LATE-1126: the founder hello's sender (`whatsapp_message_sent/dy_founder_hello`) FAILED while the person had not
 * set the product up yet, so campaign-service redelivered the occurrence on its FAILURE backoff (2, 10, 30 min) and the
 * hello went out 30 min after what it needs had landed (prod 2026-11-25, Elias Biondo: number given 15:10 during the
 * onboarding walk, before any account; 15:10 the thread read 404'd « no person holds phone:… (index built in
 * background) »; 15:12 and 15:23 the writer threw « no onboarding record »; account created 15:23:34; hello at 15:53).
 *
 * Neither is a failure: the person is not there YET. crm-service builds the onboarding record from the person's own
 * account (client-service user by email), so it cannot exist before the account. The sender now says so and asks again
 * (`again`: on an occurrence, `noWorkAvailable`, redelivered on campaign-service's short « nothing yet » cadence):
 *  - the thread read answers 404 (crm-service holds nobody under that key yet);
 *  - the person is admitted and reachable but their thread holds no onboarding record (and the record source did not
 *    fail: a failed read still reaches the writer, which throws loud).
 * The rule stays: a hello that cannot name what they set up is never written (the writer's own check is untouched).
 * A dry run (staff replay) is unchanged. Anchored edits of the STORED code; a moved anchor = nothing generated.
 */
const MARK = "HELLO-LATE-1126";

const THREAD_ANCHOR = `  const thread = person.skip === true ? NOT_CALLED : threadRead(ctx, person.timelineQuery, false);`;
const BRAND_ANCHOR = `  const brand = verdict.skip === true ? NOT_CALLED : must(ctx, "brand.profile", { params: { id: person.brandId } });`;

const THREAD = `  // ${MARK}: crm-service holding nobody under this key YET (a number given before any account) is a look to make again.
  const threadAnswer: any = person.skip === true ? NOT_CALLED : threadRead(ctx, person.timelineQuery, true);
  if (threadAnswer !== NOT_CALLED && threadAnswer.ok === false) {
    if (threadAnswer.status === 404) return { unmade: "not_set_up_yet: crm-service holds no thread for " + String(person.email ?? person.phone) + " yet (" + String(threadAnswer.error ?? "").slice(0, 300) + "); asked again", again: true };
    throw new Error("crm.person.thread failed (" + String(threadAnswer.status ?? "") + "): " + String(threadAnswer.error ?? "").slice(0, 500));
  }
  const thread = threadAnswer;`;

const BRAND = `  // ${MARK}: what they set up is not on their thread YET (their account is still to come): asked again, nothing written.
  if (verdict.skip === false && person.dryRun !== true && notSetUpYet(thread)) {
    return { unmade: "not_set_up_yet: no onboarding record on " + String(person.email ?? person.phone) + "'s thread yet (crm-service); the hello is written once it is there", again: true };
  }
${BRAND_ANCHOR}`;

const HELPER_ANCHOR = `function threadRead(ctx: any, query: unknown, tolerate: boolean): any {`;
/** Before \`threadRead\`: the record test the writer's compose makes, read on the thread the sender already holds. */
const HELPER = `/** ${MARK}: no onboarding record on the thread, and its source did not fail (a failed read is the writer's loud refusal). */
function notSetUpYet(thread: any): boolean {
  const src = (thread?.sources ?? []).find((x: any) => x?.source === "onboarding");
  if (src?.status === "failed") return false;
  const items = Array.isArray(thread?.items) ? thread.items : [];
  return !items.some((i: any) => i?.source === "onboarding" && i?.event?.step === "onboarding_record" && typeof i?.text === "string" && i.text.trim() !== "");
}

${HELPER_ANCHOR}`;

export const FOUNDER_HELLO_NOT_YET_EDITS = [
  { from: THREAD_ANCHOR, to: THREAD },
  { from: BRAND_ANCHOR, to: BRAND },
  { from: HELPER_ANCHOR, to: HELPER },
] as const;

export function addFounderHelloNotYet(code: string): string {
  if (code.includes(MARK)) throw new Error("founder hello not yet: already in the code");
  for (const { from } of FOUNDER_HELLO_NOT_YET_EDITS) {
    if (code.split(from).length !== 2) throw new Error("founder hello not yet: an anchor is not found exactly once: " + from.trim().slice(0, 60));
  }
  return FOUNDER_HELLO_NOT_YET_EDITS.reduce((c, { from, to }) => c.replace(from, () => to), code);
}

export const FOUNDER_HELLO_NOT_YET_MARK = MARK;
export const FOUNDER_HELLO_SENDER_NOT_YET = { outcome: "whatsapp_message_sent", dynasty: "dy_founder_hello" } as const;
