/**
 * MON-WA-FOUNDER-HELLO-1126: prints the catalogue write that upgrades the founder hello sender
 * (`whatsapp_message_sent/dy_founder_hello`) so a claim finding nobody ends on lead-service's reason (all_claimed =
 * asked again, nothing_due = idle) instead of failing. ONE `replace` op on that exact dynasty (its anchored edits on the
 * stored code; already carried = skipped; its recorded cases replayed server-side before anything is stored):
 *
 *   npx tsx scripts/engine-ports/founder-hello-claim-store.ts | docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… \
 *     distribute-workflow-service-1 node scripts/post-catalogue-ops.mjs [--apply]
 */
import { FOUNDER_HELLO_CLAIM_EDITS, FOUNDER_HELLO_CLAIM_MARK, FOUNDER_HELLO_SENDER } from "../../src/lib/scripts/founder-hello-claim.js";

console.log(
  JSON.stringify({
    op: "replace",
    outcome: FOUNDER_HELLO_SENDER.outcome,
    dynastyPrefix: FOUNDER_HELLO_SENDER.dynasty,
    dynasty: FOUNDER_HELLO_SENDER.dynasty,
    edits: FOUNDER_HELLO_CLAIM_EDITS,
    skipIfIncludes: FOUNDER_HELLO_CLAIM_MARK,
  }),
);
