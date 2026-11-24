/**
 * LEAD-EVENT-FOUNDER-HELLO-DOUBLE-1124: prints the catalogue writes that UPGRADE every stored WRITER carrying THE RIGHT
 * MOMENT with `OUR_MESSAGE_LAST_EDITS` (both clauses keyed on the thread's last message, both media), anchored on the
 * stored code, dry by construction: pipe it into the container's poster (`scripts/post-catalogue-ops.mjs`).
 *   npx tsx scripts/engine-ports/our-message-last-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * One op per dynasty, by its exact name (`dynasty`): no other dynasty of the outcome is touched. The four writers hold
 * no recorded case (their proofs are pair proofs, started when the version is stored). A version already carrying the
 * restated text is skipped; one holding a line in another count is NOT upgraded and named.
 * The port WITH recorded cases built from the same prompt (`client_satisfied/dy_client_whatsapp`) is upgraded with its
 * cases restated by `scripts/our-message-last-upgrade.mjs`, never here.
 */
import { OUR_MESSAGE_LAST_EDITS, OUR_MESSAGE_LAST_MARKER, OUR_MESSAGE_LAST_WRITERS, OUR_MESSAGE_LAST_WRITER_OUTCOME } from "../../src/lib/scripts/our-message-last.js";

for (const dynasty of OUR_MESSAGE_LAST_WRITERS) {
  console.log(
    JSON.stringify({
      op: "replace",
      outcome: OUR_MESSAGE_LAST_WRITER_OUTCOME,
      dynastyPrefix: dynasty,
      dynasty,
      edits: OUR_MESSAGE_LAST_EDITS.map(({ from, to }) => ({ from, to })),
      skipIfIncludes: OUR_MESSAGE_LAST_MARKER,
    }),
  );
}
