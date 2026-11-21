/**
 * ANSWER-CC-SIGNER-1121: prints the catalogue writes that UPGRADE the lead answerer's two halves so its writer knows the
 * brand's stated sales rep (`addSalesRepToSender` on `message_sent/dy_answer_lead`, `addSalesRepToWriter` on
 * `message_written/dy_answer_lead`, tactics + description unchanged).
 * Input on stdin: one JSON line per active version, `{outcome, dynasty, code, tactics, description}` (read on the box).
 *   … | npx tsx scripts/engine-ports/answer-cc-signer-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node <post-catalogue-ops.mjs> [--apply]"
 */
import { readFileSync } from "node:fs";
import { addSalesRepToSender, addSalesRepToWriter } from "../../src/lib/scripts/answer-cc-signer.js";

const edits: Record<string, (code: string) => string> = {
  "message_sent/dy_answer_lead": addSalesRepToSender,
  "message_written/dy_answer_lead": addSalesRepToWriter,
};
const seen = new Set<string>();
for (const line of readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "")) {
  const s = JSON.parse(line) as { outcome: string; dynasty: string; code: string; tactics: Record<string, unknown>; description: string };
  const id = `${s.outcome}/${s.dynasty}`;
  const edit = edits[id];
  if (!edit) continue;
  seen.add(id);
  console.log(JSON.stringify({ op: "create", body: { outcome: s.outcome, dynasty: s.dynasty, code: edit(s.code), tactics: s.tactics, description: s.description } }));
}
const missing = Object.keys(edits).filter((w) => !seen.has(w));
if (missing.length) throw new Error(`no stored version read for ${missing.join(", ")}: nothing printed for them`);
