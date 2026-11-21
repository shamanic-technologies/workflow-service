/**
 * TARGET-LED-SERVE-1121: prints the catalogue writes that UPGRADE each cold email sender of `TARGET_LED_SENDERS` to a
 * version that, on a campaign launched on its Target alone (no channel), takes its person from the Lead found Engine
 * (`addTargetLedServe` on its STORED code, tactic `asks` + `lead_found`, description unchanged). A port's upgrade
 * replays its recorded cases server-side (100 % or refused): those recorded requests state a channel, so they replay.
 * Input on stdin: one JSON line per active version, `{outcome, dynasty, code, tactics, description}` (read on the box).
 *   … | npx tsx scripts/engine-ports/target-led-serve-store.ts | ssh box "docker exec -i -e ORG_ID=… -e USER_ID=… -e STAFF_EMAIL=… <workflow-service> node <post-catalogue-ops.mjs> [--apply]"
 */
import { readFileSync } from "node:fs";
import { TARGET_LED_SENDERS, addTargetLedServe, targetLedServeTactics } from "../../src/lib/scripts/target-led-serve.js";

const wanted = new Set(TARGET_LED_SENDERS.map((s) => `${s.outcome}/${s.dynasty}`));
const seen = new Set<string>();
for (const line of readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "")) {
  const s = JSON.parse(line) as { outcome: string; dynasty: string; code: string; tactics: Record<string, unknown>; description: string };
  const id = `${s.outcome}/${s.dynasty}`;
  if (!wanted.has(id)) continue;
  seen.add(id);
  if (s.code.includes("TARGET-LED-SERVE-1121")) {
    console.error(`${id}: already asks the Lead found Engine, skipped`);
    continue;
  }
  console.log(JSON.stringify({ op: "create", body: { outcome: s.outcome, dynasty: s.dynasty, code: addTargetLedServe(s.code), tactics: targetLedServeTactics(s.tactics), description: s.description } }));
}
const missing = [...wanted].filter((w) => !seen.has(w));
if (missing.length) throw new Error(`no stored version read for ${missing.join(", ")}: nothing printed for them`);
