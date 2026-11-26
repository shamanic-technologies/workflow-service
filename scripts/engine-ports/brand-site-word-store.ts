/**
 * BRAND-SITE-WORD-1125: prints the catalogue writes that UPGRADE the lead answerer's two halves so it answers from what
 * the brand PUBLISHES (`addSiteToWriter` on `message_written/dy_answer_lead` FIRST: with no site handed it asks byte for
 * byte as before; then `addSiteToSender` on `message_sent/dy_answer_lead`, its tactic `asks` gaining `page_read`).
 * Input on stdin: one JSON line per active version, `{outcome, dynasty, version, code, tactics}` (read on the box).
 *   … | npx tsx scripts/engine-ports/brand-site-word-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node <post-catalogue-ops.mjs> [--apply]"
 */
import { readFileSync } from "node:fs";
import { addSiteToSender, addSiteToWriter, senderTacticsWithSite, BRAND_SITE_MARK } from "../../src/lib/scripts/brand-site-word.js";

type Stored = { outcome: string; dynasty: string; version: number; code: string; tactics: Record<string, unknown> };
const order: Array<[string, (s: Stored) => { code: string; tactics: Record<string, unknown> }]> = [
  ["message_written/dy_answer_lead", (s) => ({ code: addSiteToWriter(s.code), tactics: s.tactics })],
  ["message_sent/dy_answer_lead", (s) => ({ code: addSiteToSender(s.code), tactics: senderTacticsWithSite(s.tactics) })],
];
const read = new Map<string, Stored>();
for (const line of readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "")) {
  const s = JSON.parse(line) as Stored;
  read.set(`${s.outcome}/${s.dynasty}`, s);
}
for (const [id, edit] of order) {
  const s = read.get(id);
  if (!s) throw new Error(`no stored version read for ${id}: nothing printed`);
  const next = edit(s);
  console.log(JSON.stringify({ op: "upgrade", outcome: s.outcome, dynasty: s.dynasty, fromVersion: s.version, code: next.code, tactics: next.tactics, skipIfIncludes: BRAND_SITE_MARK }));
}
