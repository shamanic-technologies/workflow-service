/**
 * HELLO-LATE-1126: prints the catalogue write that upgrades the founder hello sender
 * (`whatsapp_message_sent/dy_founder_hello`) so a person not set up YET (thread 404, no onboarding record) is asked again
 * instead of failing. ONE `replace` op on that exact dynasty (anchored edits on the stored code; already carried =
 * skipped; its recorded cases replayed server-side before anything is stored):
 *
 *   npx tsx scripts/engine-ports/founder-hello-not-yet-store.ts | docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… \
 *     distribute-workflow-service-1 node scripts/post-catalogue-ops.mjs [--apply]
 */
import { FOUNDER_HELLO_NOT_YET_EDITS, FOUNDER_HELLO_NOT_YET_MARK, FOUNDER_HELLO_SENDER_NOT_YET } from "../../src/lib/scripts/founder-hello-not-yet.js";

console.log(
  JSON.stringify({
    op: "replace",
    outcome: FOUNDER_HELLO_SENDER_NOT_YET.outcome,
    dynastyPrefix: FOUNDER_HELLO_SENDER_NOT_YET.dynasty,
    dynasty: FOUNDER_HELLO_SENDER_NOT_YET.dynasty,
    edits: FOUNDER_HELLO_NOT_YET_EDITS,
    skipIfIncludes: FOUNDER_HELLO_NOT_YET_MARK,
  }),
);
