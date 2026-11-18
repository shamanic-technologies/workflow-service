/**
 * WRITER-SENDER-SPLIT-1118: prints the catalogue write that stores one half of the lead follow-up's split
 * (`splitFollowUp`), dry by construction: pipe the output into the container's poster. The stored code is read on stdin
 * as `{"code": ..., "tactics": {...}}` (the active `lead_interested/dy_follow_up_due`, read on the box), so the halves
 * are cut from what production runs, never from a copy in git. Prove first (`scripts/prove-follow-up-split.mjs`).
 *   ssh box "docker exec <pg> psql ... -At -c \"select json_build_object('code', code, 'tactics', tactics) from scripts where outcome='lead_interested' and dynasty='dy_follow_up_due' and status='active'\"" \
 *     | npx tsx scripts/engine-ports/follow-up-split-store.ts --writer|--sender \
 *     | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * `--writer` = CREATE `message_written/dy_follow_up_due` (inert until the sender asks it); `--sender` = UPGRADE
 * `lead_interested/dy_follow_up_due` (the poster's create answers 409 and upgrades with the generated code and
 * tactics; a port: the catalogue replays its recorded cases first and refuses a version that misses one).
 */
import { readFileSync } from "node:fs";
import {
  FOLLOW_UP_DYNASTY,
  FOLLOW_UP_SENDER_DESCRIPTION,
  FOLLOW_UP_SENDER_OUTCOME,
  FOLLOW_UP_WRITER_DESCRIPTION,
  FOLLOW_UP_WRITER_NAME,
  FOLLOW_UP_WRITER_OUTCOME,
  followUpTactics,
  splitFollowUp,
} from "../../src/lib/scripts/follow-up-split.js";

const which = process.argv.includes("--writer") ? "writer" : process.argv.includes("--sender") ? "sender" : null;
if (!which) throw new Error("say --writer or --sender");
const stored = JSON.parse(readFileSync(0, "utf8").trim()) as { code: string; tactics: Record<string, unknown> };
if (stored.code.includes(`ctx.get("${FOLLOW_UP_WRITER_OUTCOME}")`)) throw new Error("the active follow-up is already split (it asks its writer): nothing to generate");
const halves = splitFollowUp(stored.code);
const tactics = followUpTactics(stored.tactics);
const body =
  which === "writer"
    ? { outcome: FOLLOW_UP_WRITER_OUTCOME, dynasty: FOLLOW_UP_DYNASTY, code: halves.writer, description: FOLLOW_UP_WRITER_DESCRIPTION, tactics: tactics.writer, name: FOLLOW_UP_WRITER_NAME }
    : { outcome: FOLLOW_UP_SENDER_OUTCOME, dynasty: FOLLOW_UP_DYNASTY, code: halves.sender, description: FOLLOW_UP_SENDER_DESCRIPTION, tactics: tactics.sender };
console.log(JSON.stringify({ op: "create", body }));
