/**
 * SCRIPT-VALUE-RATING-1113-WF3: prints the catalogue writes that store the field draft scripts (one JSON line each:
 * `{method, path, body}` on workflow-service), dry by construction: pipe them into the container to apply
 * (`npx tsx scripts/engine-ports/field-drafts-store.ts | ssh box "docker exec -i <workflow-service> node -e '<poster>'"`).
 * Each Engine: the base dynasty created on its most-run LLM, every other LLM production ran FORKED from it
 * (`<dynasty>__<llm>`, same code, its own tactic `llm`). A dynasty already stored answers 409: re-running is safe.
 */
import { buildFieldDraftSource, FIELD_DRAFT_DYNASTY, FIELD_DRAFT_ENGINES, fieldDraftDescription, fieldDraftTactics, forkDynasty } from "./field-drafts.js";

const code = buildFieldDraftSource();
for (const engine of FIELD_DRAFT_ENGINES) {
  const create = {
    method: "POST",
    path: "/scripts",
    body: { outcome: engine.outcome, dynasty: FIELD_DRAFT_DYNASTY, code, description: fieldDraftDescription(engine, engine.base), tactics: fieldDraftTactics(engine.base) },
  };
  console.log(JSON.stringify(create));
  for (const llm of engine.forks) {
    console.log(
      JSON.stringify({
        method: "POST",
        path: `/scripts/dynasty/${engine.outcome}/${FIELD_DRAFT_DYNASTY}/fork`,
        body: { dynasty: forkDynasty(llm), description: fieldDraftDescription(engine, llm), tactics: fieldDraftTactics(llm) },
      }),
    );
  }
}
