/**
 * LOCAL-TIME-ANSWERER-1115: prints the ONE catalogue write that upgrades every `message_sent/dy_answer_lead*` dynasty
 * (dy_answer_lead and its LLM forks: same stored code) with `ANSWER_LOCAL_TIME_EDITS`, anchored on the stored code,
 * dry by construction: pipe it into the container's poster (`scripts/post-catalogue-ops.mjs`).
 *   npx tsx scripts/engine-ports/answer-lead-local-time-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * Retired dynasties included (`includeRetired`): the upgrade is stored retired too, so it runs only once the dynasty is
 * restored (never re-activated here). A version already carrying the local time block is skipped.
 */
import { ANSWER_LOCAL_TIME_EDITS } from "../../src/lib/scripts/answer-lead-script.js";

console.log(
  JSON.stringify({
    op: "replace",
    outcome: "message_sent",
    dynastyPrefix: "dy_answer_lead",
    includeRetired: true,
    edits: ANSWER_LOCAL_TIME_EDITS.map(({ from, to }) => ({ from, to })),
    skipIfIncludes: "function localTimeLines(",
  }),
);
