/**
 * PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2: prints the catalogue write that UPGRADES `lead_interested/dy_follow_up_due` to a
 * version that, on a campaign launched on its Target alone, takes its person from the Lead found Engine
 * (`addFollowUpTargetLed` on its STORED code, tactic `asks` + `lead_found`). The upgrade replays its recorded cases
 * server-side: they all state a channel, so they replay unchanged.
 * Input on stdin: ONE JSON line `{outcome, dynasty, version, code, tactics}` (the active version, read on the box).
 *   … | npx tsx scripts/engine-ports/follow-up-target-led-store.ts | ssh box "docker exec -i … node <post-catalogue-ops.mjs> [--apply]"
 */
import { readFileSync } from "node:fs";
import { addFollowUpTargetLed, followUpTargetLedTactics } from "../../src/lib/scripts/follow-up-target-led.js";

const lines = readFileSync(0, "utf8").split("\n").filter((l) => l.trim() !== "");
if (lines.length !== 1) throw new Error(`one active version expected on stdin, got ${lines.length}`);
const s = JSON.parse(lines[0]!) as { outcome: string; dynasty: string; version: number; code: string; tactics: Record<string, unknown> };
if (`${s.outcome}/${s.dynasty}` !== "lead_interested/dy_follow_up_due") throw new Error(`not the lead follow-up sender: ${s.outcome}/${s.dynasty}`);
console.log(JSON.stringify({ op: "upgrade", outcome: s.outcome, dynasty: s.dynasty, fromVersion: s.version, code: addFollowUpTargetLed(s.code), tactics: followUpTargetLedTactics(s.tactics), skipIfIncludes: "PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2" }));
