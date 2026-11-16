/**
 * COPY-BY-WRITER-1116: prints the ONE catalogue write that upgrades every `message_sent/dy_answer_lead*` dynasty
 * (dy_answer_lead and its LLM forks: same stored code) with `ANSWER_COPY_BY_WRITER_EDITS` (cc: "Empty = nobody is
 * copied"), anchored on the stored code, dry by construction: pipe it into the container's poster.
 *   npx tsx scripts/engine-ports/answer-lead-copy-by-writer-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * Retired dynasties included (`includeRetired`): their upgrade is stored retired. A version already carrying it is skipped.
 */
import { ANSWER_COPY_BY_WRITER_EDITS, ANSWER_CC_DESCRIPTION } from "../../src/lib/scripts/answer-lead-script.js";

console.log(
  JSON.stringify({
    op: "replace",
    outcome: "message_sent",
    dynastyPrefix: "dy_answer_lead",
    includeRetired: true,
    edits: ANSWER_COPY_BY_WRITER_EDITS.map(({ from, to }) => ({ from, to })),
    skipIfIncludes: JSON.stringify(ANSWER_CC_DESCRIPTION).slice(1, -1),
  }),
);
