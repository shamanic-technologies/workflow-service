#!/usr/bin/env node
/**
 * WRITER-SENDER-SPLIT-1119-FOUNDER: proves the cut of the founder hello (`whatsapp_message_sent/dy_founder_hello`) on
 * production's own recorded cases BEFORE anything is stored, then prints the catalogue writes.
 *
 * Cases: every `writer_cases` row of the unsplit code (same md5: its runs that reached their model) and every replay case
 * of the dynasty (`script_cases`, the port's restated Windmill runs). The stored code and its two halves
 * (`splitFounderHello`) run in the sandbox on the same record (each door answered from it, in order; the model answered
 * by the recorded completion; nothing called, nothing sent) and are compared call by call: the same doors with the same
 * bodies (the store's `completion.runId` aside: the door fills it with the writer's run), the model asked the same
 * request, the same end. One case that differs = exit 1: nothing may be stored. Prints counts and ids only.
 *
 * `--ops writer` prints the CREATE of `message_written/dy_founder_hello`; `--ops sender` prints the UPGRADE of the
 * sender with its replay cases restated (a case that never reaches the writer stands as it is; a case whose sender asked
 * the writer becomes the sender's own record: the writer's Unit as its material, its ask, its doors; a case the WRITER
 * fails on is the writer's, left out of the sender's). Pipe into `node scripts/post-catalogue-ops.mjs [--apply]`.
 * `--writer-cases [--apply]` keeps each case's writer half as a `message_written` case (what its pair proofs replay).
 *
 * Runs inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-founder-hello-split.mjs [--ops writer|sender] [--writer-cases [--apply]]
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scriptCases, scripts, writerCases } from "../dist/db/schema.js";
import { readMaterials, runScript } from "../dist/lib/scripts/sandbox.js";
import { sameJson } from "../dist/lib/scripts/replay.js";
import {
  FOUNDER_HELLO_DYNASTY as DYNASTY,
  FOUNDER_HELLO_REQUESTED,
  FOUNDER_HELLO_SENDER_DESCRIPTION,
  FOUNDER_HELLO_SENDER_OUTCOME as SENDER,
  FOUNDER_HELLO_WRITER_DESCRIPTION,
  FOUNDER_HELLO_WRITER_NAME,
  FOUNDER_HELLO_WRITER_OUTCOME as WRITER,
  compareFounderHelloOnCase,
  founderHelloTactics,
  senderReplayCase,
  splitFounderHello,
  storedCaseOfReplay,
} from "../dist/lib/scripts/founder-hello-split.js";

const argAfter = (flag) => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
};
const ops = argAfter("--ops");
const keep = process.argv.includes("--writer-cases");
const apply = process.argv.includes("--apply");
// With --ops the catalogue write is stdout's only line: everything else goes to stderr.
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
const md5 = (s) => createHash("md5").update(s).digest("hex");
const active = async (outcome) =>
  (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, DYNASTY), eq(scripts.status, "active"))))[0] ?? null;

const sender = await active(SENDER);
if (!sender) throw new Error(`no active ${SENDER}/${DYNASTY}`);
const already = sender.code.includes(`ctx.get("${WRITER}")`);
// Once the sender is upgraded, its stored code is the sender half: the unsplit code is its previous version.
const unsplit = already
  ? (await db.select().from(scripts).where(and(eq(scripts.outcome, SENDER), eq(scripts.dynasty, DYNASTY), eq(scripts.version, sender.version - 1))))[0]
  : sender;
if (!unsplit || unsplit.code.includes(`ctx.get("${WRITER}")`)) throw new Error("the unsplit founder hello is not the active version nor the one before it");
const halves = splitFounderHello(unsplit.code);
const codeMd5 = md5(unsplit.code);
const tactics = founderHelloTactics(unsplit.tactics ?? {});
const unfed = { sender: readMaterials(halves.sender).filter((m) => !tactics.sender.asks.includes(m)), writer: readMaterials(halves.writer).filter((m) => !tactics.writer.asks.includes(m)) };
log(`materials: sender ${JSON.stringify(readMaterials(halves.sender))} asks ${JSON.stringify(tactics.sender.asks)}; writer ${JSON.stringify(readMaterials(halves.writer))} asks ${JSON.stringify(tactics.writer.asks)}`);
if (unfed.sender.length > 0 || unfed.writer.length !== 1 || unfed.writer[0] !== FOUNDER_HELLO_REQUESTED) {
  log(`a half reads a material nobody hands it (sender: ${JSON.stringify(unfed.sender)}, writer beyond ${FOUNDER_HELLO_REQUESTED}: ${JSON.stringify(unfed.writer)}): nothing may be stored`);
  process.exit(1);
}
log(`unsplit code: ${SENDER}/${DYNASTY}/v${unsplit.version} (md5 ${codeMd5})${already ? ", the active version is already the sender half" : ""}`);

const recorded = (await db.select().from(writerCases).where(eq(writerCases.outcome, SENDER))).filter((c) => c.codeMd5 === codeMd5);
const replays = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, SENDER), eq(scriptCases.dynasty, DYNASTY)));
const all = [
  ...recorded.map((c) => ({ id: c.runId, kind: "recorded", row: c, body: c.body, replay: null })),
  ...replays.map((r) => ({ id: r.caseId, kind: "replay", row: null, body: storedCaseOfReplay(r.body), replay: r.body })),
];
const SENDS = new Set(["crm.whatsapp.send"]);
const count = { recorded: recorded.length, replays: replays.length, unfit: 0, same: 0, different: 0, sendsCompared: 0, asksCompared: 0, writerAsked: 0, writerWrote: 0, writerFailed: 0 };
const different = [];
const senderCases = [];
const excluded = {};
const writerOnes = [];
for (const k of all) {
  const r = await compareFounderHelloOnCase(unsplit.code, halves, k.body, runScript, sameJson);
  if (r.stored.end.kind === "stopped") {
    // The stored code itself does not replay on this record: no evidence either way.
    count.unfit++;
    if (k.replay) excluded[k.id] = `the stored code does not replay it: ${r.stored.end.reason}`;
    continue;
  }
  if (!r.same) {
    count.different++;
    different.push(`${k.kind} ${k.id}: ${r.diff}`);
    continue;
  }
  count.same++;
  count.sendsCompared += r.stored.steps.filter((s) => s.kind === "vendor" && SENDS.has(s.name)).length;
  count.asksCompared += r.stored.steps.filter((s) => s.kind === "ask").length;
  if (!r.handed) {
    if (k.replay) senderCases.push(k.replay);
    continue;
  }
  count.writerAsked++;
  if (r.written) {
    count.writerWrote++;
    senderCases.push(senderReplayCase(k.id, k.body, r));
  } else {
    count.writerFailed++;
    excluded[k.id] = `the writer fails on it (${r.split.end.kind === "stopped" ? r.split.end.reason.slice(0, 120) : r.split.end.kind}): the writer's case now, not the sender's`;
  }
  const writerCalls = k.body.calls.filter((x) => ["template.pick", "content.template_head", "content.whatsapp.request", "content.whatsapp.generate"].includes(x.name));
  writerOnes.push({
    k,
    wrote: !!r.written,
    body: { units: { [FOUNDER_HELLO_REQUESTED]: { content: r.handed.content } }, request: null, tactics: {}, subject: r.handed.subject ?? k.body.subject, brand: k.body.brand, day: k.body.day, calls: writerCalls, asked: { llm_completion: k.body.asked?.llm_completion } },
  });
}
log(JSON.stringify(count));
for (const d of different.slice(0, 20)) log(`DIFFERENT ${d}`);
if (count.different > 0) {
  log("the halves do NOT do what the stored code did on every recorded case: nothing may be stored");
  process.exit(1);
}

if (ops === "writer") {
  console.log(JSON.stringify({ op: "create", body: { outcome: WRITER, dynasty: DYNASTY, code: halves.writer, description: FOUNDER_HELLO_WRITER_DESCRIPTION, tactics: tactics.writer, name: FOUNDER_HELLO_WRITER_NAME } }));
} else if (ops === "sender") {
  log(`sender cases: ${senderCases.length} (${Object.keys(excluded).length} left out)`);
  console.log(
    JSON.stringify({
      op: "upgradeWithCases",
      outcome: SENDER,
      dynasty: DYNASTY,
      code: halves.sender,
      description: FOUNDER_HELLO_SENDER_DESCRIPTION,
      tactics: tactics.sender,
      source: "WRITER-SENDER-SPLIT-1119-FOUNDER: the founder hello's cases restated for its sender half (the writer's doors and model now the founder hello writer's)",
      cases: senderCases,
      excluded,
    }),
  );
} else if (ops) throw new Error(`--ops writer|sender, not ${ops}`);

if (keep) {
  const writer = await active(WRITER);
  if (apply && !writer) throw new Error(`no active ${WRITER}/${DYNASTY}: store the writer first`);
  if (writer && writer.code !== halves.writer) throw new Error("the stored writer is not the writer cut from the unsplit code: nothing kept");
  let kept = 0;
  for (const w of writerOnes) {
    if (!apply || !w.k.row) continue;
    const inserted = await db
      .insert(writerCases)
      .values({ outcome: WRITER, runId: w.k.row.runId, recordedFrom: `${WRITER}/${DYNASTY}/v${writer.version} (from ${w.k.row.recordedFrom})`, codeMd5: md5(writer.code), wrote: w.wrote, orgId: w.k.row.orgId, body: w.body, createdAt: w.k.row.createdAt })
      .onConflictDoNothing()
      .returning({ id: writerCases.id });
    kept += inserted.length;
  }
  log(`${writerOnes.filter((w) => w.k.row).length} writer cases from recorded runs (${writerOnes.filter((w) => w.k.row && w.wrote).length} wrote)${apply ? `: ${kept} kept now` : " (dry run)"}`);
}
process.exit(0);
