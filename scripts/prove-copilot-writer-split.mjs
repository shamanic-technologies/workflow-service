#!/usr/bin/env node
/**
 * WRITER-SENDER-SPLIT-1119-COPILOT: proves the cut of a Copilot-writing script (`paid_client/dy_client_check_in`,
 * `paid_client/dy_brand_team`) on the dynasty's recorded cases (`script_cases`) BEFORE anything is stored, then prints
 * the catalogue writes. The stored code and its halves (`splitCopilotWriter`) run in the sandbox on the same record
 * (every door answered from it in order, the Copilot's lead turn included; nothing called, nothing sent) and are compared
 * call by call: the same doors with the same bodies, the same end. One case that differs = exit 1. Prints counts and ids.
 *
 * `--ops writer` prints the CREATE of `message_written/<dynasty>`; `--ops sender` prints the UPGRADE of the sender with
 * its cases restated (a case whose sender asked the writer: the writer's answer as its material, its ask, its doors
 * minus the Copilot's turn; a case the writer fails on is left out). Pipe into `node scripts/post-catalogue-ops.mjs`.
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-copilot-writer-split.mjs <dynasty> [--ops writer|sender] [--store-sender [--apply]]
 */
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts } from "../dist/db/schema.js";
import { readMaterials, runScript } from "../dist/lib/scripts/sandbox.js";
import { sameJson } from "../dist/lib/scripts/replay.js";
import {
  COPILOT_SENDER_OUTCOME as SENDER,
  COPILOT_SPLIT_DYNASTIES,
  COPILOT_SPLIT_TEXT,
  COPILOT_WRITER_OUTCOME as WRITER,
  compareCopilotOnCase,
  copilotSenderCase,
  copilotSplitTactics,
  requestedOf,
  splitCopilotWriter,
} from "../dist/lib/scripts/copilot-writer-split.js";

const dynasty = process.argv[2];
if (!COPILOT_SPLIT_DYNASTIES.includes(dynasty)) throw new Error(`say one of ${COPILOT_SPLIT_DYNASTIES.join(", ")}`);
const i = process.argv.indexOf("--ops");
const ops = i >= 0 ? process.argv[i + 1] : null;
const log = (...a) => (ops ? console.error(...a) : console.log(...a));

const sender = (await db.select().from(scripts).where(and(eq(scripts.outcome, SENDER), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"))))[0];
if (!sender) throw new Error(`no active ${SENDER}/${dynasty}`);
const already = sender.code.includes(`ctx.get("${WRITER}")`);
const unsplit = already ? (await db.select().from(scripts).where(and(eq(scripts.outcome, SENDER), eq(scripts.dynasty, dynasty), eq(scripts.version, sender.version - 1))))[0] : sender;
if (!unsplit || unsplit.code.includes(`ctx.get("${WRITER}")`)) throw new Error("the unsplit code is not the active version nor the one before it");
const halves = splitCopilotWriter(unsplit.code, dynasty);
const tactics = copilotSplitTactics(unsplit.tactics ?? {});
const requested = requestedOf(dynasty);
log(`materials: sender ${JSON.stringify(readMaterials(halves.sender))} asks ${JSON.stringify(tactics.sender.asks)}; writer ${JSON.stringify(readMaterials(halves.writer))}`);
if (readMaterials(halves.sender).some((m) => !tactics.sender.asks.includes(m)) || JSON.stringify(readMaterials(halves.writer)) !== JSON.stringify([requested])) {
  log("a half reads a material nobody hands it: nothing may be stored");
  process.exit(1);
}
log(`unsplit code: ${SENDER}/${dynasty}/v${unsplit.version}${already ? ", the active version is already the sender half" : ""}`);

const rows = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, SENDER), eq(scriptCases.dynasty, dynasty)));
const count = { cases: rows.length, unfit: 0, same: 0, different: 0, sends: 0, copilotTurns: 0, writerAsked: 0, writerWrote: 0, writerDecidedOther: 0, writerFailed: 0 };
const different = [];
const senderCases = [];
const excluded = {};
const SENDS = new Set(["crm.whatsapp.send", "email.send"]);
for (const row of rows) {
  const c = { ...row.body, id: row.caseId };
  const r = await compareCopilotOnCase(unsplit.code, halves, dynasty, c, runScript, sameJson);
  if (r.stored.end.kind === "stopped") {
    count.unfit++;
    excluded[row.caseId] = `the stored code does not replay it: ${r.stored.end.reason.slice(0, 160)}`;
    continue;
  }
  if (!r.same) {
    count.different++;
    different.push(`${row.caseId}: ${r.diff}`);
    continue;
  }
  count.same++;
  count.sends += r.stored.steps.filter((s) => SENDS.has(s.name)).length;
  count.copilotTurns += r.stored.steps.filter((s) => s.name === "chat.copilot.lead_turn").length;
  if (!r.ask) {
    senderCases.push(row.body);
    continue;
  }
  count.writerAsked++;
  if (!r.said) {
    count.writerFailed++;
    excluded[row.caseId] = "the writer fails on it: the writer's case now, not the sender's";
    continue;
  }
  if (r.said.decision === "write") count.writerWrote++;
  else count.writerDecidedOther++;
  const { id: _id, ...restated } = copilotSenderCase(c, r);
  senderCases.push({ ...restated, id: row.body.id ?? row.caseId });
}
log(JSON.stringify(count));
for (const d of different.slice(0, 20)) log(`DIFFERENT ${d}`);
if (count.different > 0) {
  log("the halves do NOT do what the stored code did on every recorded case: nothing may be stored");
  process.exit(1);
}
const text = COPILOT_SPLIT_TEXT[dynasty];
if (ops === "writer") {
  console.log(JSON.stringify({ op: "create", body: { outcome: WRITER, dynasty, code: halves.writer, description: text.writerDescription, tactics: tactics.writer, name: text.writerName } }));
} else if (ops === "sender") {
  log(`sender cases: ${senderCases.length} (${Object.keys(excluded).length} left out)`);
  console.log(
    JSON.stringify({
      op: "upgradeWithCases",
      outcome: SENDER,
      dynasty,
      code: halves.sender,
      description: text.senderDescription,
      tactics: tactics.sender,
      source: "WRITER-SENDER-SPLIT-1119-COPILOT: the dynasty's cases restated for its sender half (the Copilot's turn now its writer's)",
      cases: senderCases,
      excluded,
    }),
  );
} else if (ops) throw new Error(`--ops writer|sender, not ${ops}`);

// `--store-sender [--apply]`: the same upgrade as the catalogue route (`upgradeScript` with its cases replaced), made in
// this process: a dynasty whose cases hold whole threads (dy_brand_team: 80 MB) is past the route's body limit. Dry =
// the halves' sender replayed on the restated cases, nothing written. Needs STAFF_EMAIL and ORG_ID (who decided).
if (process.argv.includes("--store-sender")) {
  const { replayAll } = await import("../dist/lib/scripts/replay.js");
  const { upgradeScript } = await import("../dist/lib/scripts/script-catalogue.js");
  const summary = await replayAll(halves.sender, senderCases.map((c) => ({ ...c, tactics: { ...tactics.sender, ...(c.tactics ?? {}) } })));
  log(`sender replay on its restated cases: ${summary.matches}/${summary.cases}`);
  if (summary.matches !== summary.cases) process.exit(1);
  if (process.argv.includes("--apply")) {
    if (already) throw new Error("the active version is already the sender half: nothing stored");
    const { ORG_ID, STAFF_EMAIL } = process.env;
    if (!ORG_ID || !STAFF_EMAIL) throw new Error("ORG_ID and STAFF_EMAIL (who decided) are required");
    const row = await upgradeScript(db, SENDER, dynasty, { code: halves.sender, description: text.senderDescription, tactics: tactics.sender, replaceCases: { cases: senderCases, source: "WRITER-SENDER-SPLIT-1119-COPILOT: the dynasty's cases restated for its sender half (the Copilot's turn now its writer's)" } }, { orgId: ORG_ID, createdBy: STAFF_EMAIL });
    log(`upgraded ${row.outcome}/${row.dynasty}/v${row.version} replay=${JSON.stringify(row.replay)}`);
  }
}
process.exit(0);
