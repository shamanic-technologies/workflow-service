/**
 * INTRO-BOARDY-1114: prints the catalogue writes that store the intro scripts, one JSON line each, dry by construction:
 * pipe them into the container's poster (`scripts/post-catalogue-ops.mjs`), which applies each one idempotently.
 *   npx tsx scripts/engine-ports/intro-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 *
 * 1. create: the path, the three first emails, the intro conversation (a dynasty already stored answers 409: skipped).
 * 2. replace: every `message_sent/dy_answer_lead*` dynasty UPGRADED to step aside while an intro holds the lead
 *    (anchored on its stored code; a version already reading a hold is skipped).
 * 3. tag: every cold email writer (`email_sent/dy_cold_email*`) UPGRADED with the same code and the tactic that says it
 *    pitches the offer (a version already carrying it is skipped).
 */
import {
  ANSWERER_OWNER_CHECK,
  ANSWERER_OWNER_CHECK_WITH_HOLD,
  buildIntroAnswerSource,
  buildIntroFirstEmailSource,
  buildIntroPathSource,
  INTRO_ANSWER,
  INTRO_FIRST_EMAILS,
  INTRO_PATH,
  OFFER_PITCH_TACTIC,
} from "./intro.js";
import { askCompletionSource, askCompletionTactics } from "./ask-completion.js";
import { ASKING_SCRIPTS } from "./ask-completion-scripts.js";

const out = (o: unknown) => console.log(JSON.stringify(o));
/**
 * ONE-WRITER-N-MODELS-1116-OTHERS: the intro scripts name no model, they ASK the LLM completion Engine. The generator
 * keeps its one `complete` helper; the same anchored rewrite the catalogue applied is applied here, so an upgrade
 * from this generator never puts a model back (INTRO-BOARDY-LEVEL-1117: v4 did, v5 restored the ask).
 */
const asking = (outcome: string, dynasty: string, code: string, tactics: Record<string, unknown>) => {
  const def = ASKING_SCRIPTS.find((x) => x.outcome === outcome && x.dynasty === dynasty);
  if (!def) throw new Error(`${outcome}/${dynasty}: not an asking script`);
  return { code: askCompletionSource(code, def.edits, `${outcome}/${dynasty}`, def.append ?? ""), tactics: { ...askCompletionTactics(tactics), ...(def.addTactics ?? {}) } };
};
const create = (d: { outcome: string; dynasty: string; description: string; tactics: Record<string, unknown> }, code: string) =>
  out({ op: "create", body: { outcome: d.outcome, dynasty: d.dynasty, description: d.description, ...asking(d.outcome, d.dynasty, code, d.tactics) } });
const first = buildIntroFirstEmailSource();
for (const d of INTRO_FIRST_EMAILS) create(d, first);
create(INTRO_ANSWER, buildIntroAnswerSource());
// The path last: once it is runnable, an intro campaign's tick asks for the scripts above.
create(INTRO_PATH, buildIntroPathSource());
out({ op: "replace", outcome: "message_sent", dynastyPrefix: "dy_answer_lead", from: ANSWERER_OWNER_CHECK, to: ANSWERER_OWNER_CHECK_WITH_HOLD, skipIfIncludes: "owner.holdUntil" });
out({ op: "tag", outcome: "email_sent", dynastyPrefix: "dy_cold_email", tactics: OFFER_PITCH_TACTIC });
