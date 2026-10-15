/**
 * What a run did with the item its trigger OCCURRENCE carried, told to campaign-service on `/end-run`
 * (PUSHED-TRUTH-1015). campaign-service can only know whether a pushed email left if the run SAYS so: before this,
 * a send instantly-service refused (`recent_brand_contact`) ended `success: true` and the client read its occurrence
 * as sent, and one refused with an unlisted code (`email_not_verified`) threw, `success: false`, and was redelivered
 * six times over ~4 h although no retry could change the sender's verdict.
 *
 * `/end-run` body field `delivery` (optional, owned by campaign-service):
 *  - `{ state: "delivered" }`: the run did what its occurrence carried (the sender accepted the email).
 *  - `{ state: "refused", code, reason }`: the sender refused the item for a reason a retry cannot change (code and
 *    sentence verbatim). campaign-service ends the occurrence for that campaign at once, whatever `success` says.
 *  - absent: as before (success = delivered, failure = redelivered, bounded).
 *
 * The mechanism is general, never a trigger branch: a send node lists `OCCURRENCE_SEND_REFUSAL_CODES` as its
 * `skipOnRefusalCodes` (any 409 naming a code is read, `scripts/nodes/http-call.ts`), the http call's refusal output
 * already carries `delivery`, and the refused path's end-run maps it with `refusedDelivery(sendNodeId)`. A 5xx, a
 * transport error or a 402 (credits) still throws: the run fails and campaign-service redelivers, bounded.
 */
import { REFUSAL_SKIP_CODES } from "./dag-to-openflow.js";

/** In `skipOnRefusalCodes`: ANY code the sender names on a 409 is a refusal, read rather than thrown. */
export const ANY_SENDER_REFUSAL = "*";

/** The refusal list of a send that answers a trigger occurrence: every sender refusal is final. */
export const OCCURRENCE_SEND_REFUSAL_CODES: string[] = [...REFUSAL_SKIP_CODES, ANY_SENDER_REFUSAL];

/** The `/end-run` body field of a run whose send was accepted. */
export const DELIVERED = { state: "delivered" } as const;

/** The input mapping of a refused path's end-run: the send's refusal output states the delivery verbatim. */
export function refusedDelivery(sendNodeId: string): Record<string, string> {
  return { "body.delivery": `$ref:${sendNodeId}.output.delivery` };
}
