/**
 * ONE-WRITER-N-MODELS-1116: prints the catalogue writes that store the LLM completion Engine's scripts, one per model
 * (one JSON line each), dry by construction: pipe them into the container's poster, which applies each idempotently.
 *   npx tsx scripts/engine-ports/llm-completion-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * A script already stored is upgraded to this code only when its active version differs.
 */
import { buildCompletionSource, COMPLETION_LLMS, completionDescription, completionDynasty, completionTactics, LLM_COMPLETION } from "./llm-completion.js";

const code = buildCompletionSource();
for (const llm of COMPLETION_LLMS) {
  console.log(
    JSON.stringify({
      op: "create",
      body: { outcome: LLM_COMPLETION, dynasty: completionDynasty(llm), name: llm.name, code, description: completionDescription(llm), tactics: completionTactics(llm) },
    }),
  );
}
