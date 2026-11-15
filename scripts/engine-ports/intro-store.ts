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

const out = (o: unknown) => console.log(JSON.stringify(o));
const first = buildIntroFirstEmailSource();
for (const d of INTRO_FIRST_EMAILS) out({ op: "create", body: { outcome: d.outcome, dynasty: d.dynasty, code: first, description: d.description, tactics: d.tactics } });
out({ op: "create", body: { outcome: INTRO_ANSWER.outcome, dynasty: INTRO_ANSWER.dynasty, code: buildIntroAnswerSource(), description: INTRO_ANSWER.description, tactics: INTRO_ANSWER.tactics } });
// The path last: once it is runnable, an intro campaign's tick asks for the scripts above.
out({ op: "create", body: { outcome: INTRO_PATH.outcome, dynasty: INTRO_PATH.dynasty, code: buildIntroPathSource(), description: INTRO_PATH.description, tactics: INTRO_PATH.tactics } });
out({ op: "replace", outcome: "message_sent", dynastyPrefix: "dy_answer_lead", from: ANSWERER_OWNER_CHECK, to: ANSWERER_OWNER_CHECK_WITH_HOLD, skipIfIncludes: "owner.holdUntil" });
out({ op: "tag", outcome: "email_sent", dynastyPrefix: "dy_cold_email", tactics: OFFER_PITCH_TACTIC });
