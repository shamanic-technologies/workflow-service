/**
 * ONE-WRITER-N-MODELS-1116-ANSWERER: prints the catalogue write(s) that split the STORED lead answerer into its writer
 * and its sender (`splitAnswerLead`), dry by construction: pipe the output into the container's poster. The stored
 * code is read on stdin as `{"code": ..., "tactics": {...}}` (the active `message_sent/dy_answer_lead`, read on the box),
 * so the generated halves are cut from what production runs, never from a copy in git.
 *   ssh box "docker exec <pg> psql ... -At -c \"select json_build_object('code', code, 'tactics', tactics) from scripts where outcome='message_sent' and dynasty='dy_answer_lead' and status='active'\"" \
 *     | npx tsx scripts/engine-ports/answer-lead-split-store.ts --writer|--sender \
 *     | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * `--writer` = CREATE `message_written/dy_answer_lead` (inert until a sender asks it); `--sender` = UPGRADE
 * `message_sent/dy_answer_lead` (the poster's create answers 409 and upgrades with the generated code and tactics).
 */
import { readFileSync } from "node:fs";
import {
  ANSWER_DYNASTY,
  ANSWER_SENDER_DESCRIPTION,
  ANSWER_SENDER_OUTCOME,
  ANSWER_WRITER_DESCRIPTION,
  ANSWER_WRITER_NAME,
  ANSWER_WRITER_OUTCOME,
  answerTactics,
  splitAnswerLead,
} from "../../src/lib/scripts/answer-lead-split.js";

const which = process.argv.includes("--writer") ? "writer" : process.argv.includes("--sender") ? "sender" : null;
if (!which) throw new Error("say --writer or --sender");
const stored = JSON.parse(readFileSync(0, "utf8").trim()) as { code: string; tactics: Record<string, unknown> };
if (!stored.code.includes('"llm.pick"')) throw new Error("the active answerer is already split (it calls no LLM): nothing to generate");
const halves = splitAnswerLead(stored.code);
const tactics = answerTactics(stored.tactics);
const body =
  which === "writer"
    ? { outcome: ANSWER_WRITER_OUTCOME, dynasty: ANSWER_DYNASTY, code: halves.writer, description: ANSWER_WRITER_DESCRIPTION, tactics: tactics.writer, name: ANSWER_WRITER_NAME }
    : { outcome: ANSWER_SENDER_OUTCOME, dynasty: ANSWER_DYNASTY, code: halves.sender, description: ANSWER_SENDER_DESCRIPTION, tactics: tactics.sender };
console.log(JSON.stringify({ op: "create", body }));
