#!/usr/bin/env node
/**
 * INTRO-VERIFY-BEFORE-WRITE-1124: proves the look-before-writing upgrades of the intro scripts BEFORE anything is
 * stored, then prints the catalogue writes. It writes NOTHING itself and calls nobody (reads `scripts`, `script_cases`
 * and `writer_cases` only).
 *
 * - The three intro first emails (`email_sent/dy_intro_open | _lead_to_lead | _client_to_lead`, one code): the cold
 *   senders' look through the intro shape (`addVerifyBeforeWrite(code, INTRO_FIRST_EMAIL_SHAPE)`), tactic
 *   `verdictMaxAgeDays: 30`.
 * - The intro conversation (`message_sent/dy_intro_answer`): the send's check on the other person's address before its
 *   writer (`addIntroAnswerCheck`), tactic `checksEmailBeforeWriter: true`.
 *
 * Per dynasty, on whatever production recorded for it:
 * - `script_cases` (a port's cases): a first email's are restated under the rule and replayed like the cold senders'
 *   (`restateCaseForVerifyBeforeWrite`, `replayAll`); the conversation's are replayed as stored (its tactic absent).
 * - `writer_cases` (recorded runs: every door's answer, the asked completion): the stored code and the upgrade run in
 *   the sandbox on the same record. Tactic ABSENT = the very same calls, asks and end, on every record. Tactic ON =
 *   the same again when the run never reaches the look; a record that reaches it holds what its send's door did with
 *   the address, or is excluded with its reason (a verdict nobody recorded is never invented).
 * One record that differs = exit 1: nothing may be stored. Prints counts, run ids and reasons only (cases hold personal
 * data).
 *
 * `--ops` prints one `upgrade` line per dynasty for `node scripts/post-catalogue-ops.mjs` (dry run first).
 *
 * Inside the workflow-service container, from /app/scripts (it reads ../dist):
 *   docker exec <container> node scripts/prove-intro-verify-before-write.mjs [--ops]
 * Or on a build of this repo, the read piped from the box (`--print-sql` prints the read-only query):
 *   node scripts/prove-intro-verify-before-write.mjs --print-sql | ssh <box> "docker exec -i <postgres> psql -U postgres -d workflow_service -At" | node scripts/prove-intro-verify-before-write.mjs --stdin [--ops]
 */
import { readFileSync } from "node:fs";

const DYNASTIES = [
  ["email_sent", "dy_intro_open"],
  ["email_sent", "dy_intro_lead_to_lead"],
  ["email_sent", "dy_intro_client_to_lead"],
  ["message_sent", "dy_intro_answer"],
];
const IN = DYNASTIES.map(([o, d]) => `('${o}','${d}')`).join(",");
const SQL = `SELECT json_build_object(
  'scripts', (SELECT coalesce(json_agg(json_build_object('outcome', outcome, 'dynasty', dynasty, 'version', version, 'code', code, 'tactics', tactics)), '[]'::json) FROM scripts WHERE (outcome, dynasty) IN (${IN}) AND status='active' AND dynasty_status='active'),
  'scriptCases', (SELECT coalesce(json_agg(json_build_object('outcome', outcome, 'dynasty', dynasty, 'caseId', case_id, 'body', body)), '[]'::json) FROM script_cases WHERE (outcome, dynasty) IN (${IN})),
  'writerCases', (SELECT coalesce(json_agg(json_build_object('id', run_id, 'recordedFrom', recorded_from, 'wrote', wrote, 'body', body)), '[]'::json) FROM writer_cases WHERE ${DYNASTIES.map(([o, d]) => `recorded_from LIKE '${o}/${d}/%'`).join(" OR ")})
);`;
if (process.argv.includes("--print-sql")) {
  console.log(SQL);
  process.exit(0);
}

const { runScript, validateSource, readMaterials } = await import("../dist/lib/scripts/sandbox.js");
const { replayAll, sameJson } = await import("../dist/lib/scripts/replay.js");
const { INTRO_FIRST_EMAILS, INTRO_FIRST_EMAIL_SHAPE, EMAIL_FOUND_OUTCOME, SEND_CHECK_DOOR, VERIFY_DOOR, addVerifyBeforeWrite, readAnswerFromRecord, restateCaseForVerifyBeforeWrite, verifyBeforeWriteTactics } = await import("../dist/lib/scripts/verify-before-write.js");
const { INTRO_ANSWER_CHECK_DOOR, INTRO_ANSWER_CHECK_MARK, INTRO_ANSWER_CHECK_TACTIC, INTRO_ANSWER_SENDERS, addIntroAnswerCheck, introAnswerCheckTactics } = await import("../dist/lib/scripts/intro-answer-check-before-write.js");

const ops = process.argv.includes("--ops");
const log = (...a) => (ops ? console.error(...a) : console.log(...a));
const FIRST_MARK = "VERIFY-BEFORE-WRITE-1124";
const json = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

async function load() {
  if (process.argv.includes("--stdin")) return JSON.parse(readFileSync(0, "utf8"));
  const { and, eq, like } = await import("drizzle-orm");
  const { db } = await import("../dist/db/index.js");
  const { scripts, scriptCases, writerCases } = await import("../dist/db/schema.js");
  const out = { scripts: [], scriptCases: [], writerCases: [] };
  for (const [outcome, dynasty] of DYNASTIES) {
    const active = (await db.select().from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active"))))[0];
    if (active) out.scripts.push({ outcome, dynasty, version: active.version, code: active.code, tactics: active.tactics });
    for (const r of await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)))) out.scriptCases.push({ outcome, dynasty, caseId: r.caseId, body: r.body });
    for (const r of await db.select().from(writerCases).where(like(writerCases.recordedFrom, `${outcome}/${dynasty}/%`))) out.writerCases.push({ id: r.runId, recordedFrom: r.recordedFrom, wrote: r.wrote, body: r.body });
  }
  return out;
}

/**
 * One code on one recorded run: every door answered from the record (first unused call of that name), an asked Unit
 * and a handed one from the record, storage in memory. `special(name, args)` answers the doors the upgrade adds
 * (a Provider read is named `provider:<outcome>`); undefined = not one of them.
 */
async function replay(code, body, tactics, special) {
  const steps = [];
  const used = new Set();
  const store = new Map();
  let stopWhy = null;
  const end = await runScript(code, { subject: body.subject ?? null, brand: body.brand ?? "replay", day: body.day ?? 0, tactics, request: body.request ?? null }, async (op, args) => {
    if (op === "get" && args.length > 1) {
      const name = `provider:${String(args[0])}`;
      steps.push({ kind: "read", name, args: json(args[1] ?? null) });
      const a = special ? special(name, args[1]) : undefined;
      if (a === undefined) return { stop: (stopWhy = `${name} is not recorded`) };
      return "stop" in a ? { stop: (stopWhy = a.stop) } : { v: json(a.v) };
    }
    if (op === "vendor") {
      const name = String(args[0]);
      steps.push({ kind: "vendor", name, args: json(args[1] ?? null) });
      const a = special ? special(name, args[1]) : undefined;
      if (a !== undefined) return "stop" in a ? { stop: (stopWhy = a.stop) } : { v: json(a.v) };
      const at = (body.calls ?? []).findIndex((r, i) => !used.has(i) && r.name === name);
      if (at < 0) return { stop: (stopWhy = `${name} is not recorded`) };
      used.add(at);
      return { v: json(body.calls[at].answer) };
    }
    if (op === "ask") {
      steps.push({ kind: "ask", name: "ask", args: json(args[0] ?? null) });
      return { v: null };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      const held = (body.units ?? {})[outcome];
      if (held !== undefined) return { v: { id: `case:${outcome}`, outcome, subject: body.subject ?? "", ageDays: 0, content: json(Array.isArray(held) ? held[0] : held) } };
      const asked = (body.asked ?? {})[outcome];
      return asked !== undefined ? { v: json(asked) } : { stop: (stopWhy = `${outcome} is not recorded`) };
    }
    if (op === "consume") return { v: null };
    const key = `${String(args[0])}\u0000${String(args[1])}`;
    if (op === "storage.get") return { v: store.has(key) ? json(store.get(key)) : null };
    if (op === "storage.set" || (op === "storage.claim" && !store.has(key))) store.set(key, json(args[2] ?? null));
    if (op === "storage.set") return { v: null };
    if (op === "storage.claim") return { v: json(store.get(key) ?? null) };
    if (op === "storage.delete") {
      store.delete(key);
      return { v: null };
    }
    if (op === "storage.count") return { v: [...store.keys()].filter((k) => k.startsWith(`${String(args[0])}\u0000`)).length };
    return { stop: (stopWhy = `${String(op)} asked`) };
  });
  return { steps, end, stopWhy };
}

function firstDiff(a, b, added) {
  const got = b.steps.filter((s) => !added.includes(s.name));
  if (a.steps.length !== got.length) return `the stored code made ${a.steps.length} calls, the upgrade ${got.length}`;
  for (let i = 0; i < got.length; i++) {
    if (a.steps[i].kind !== got[i].kind || a.steps[i].name !== got[i].name) return `call ${i + 1}: the stored code made ${a.steps[i].name}, the upgrade ${got[i].name}`;
    if (!sameJson(a.steps[i].args, got[i].args)) return `call ${i + 1} ${got[i].name}: not the same request`;
  }
  return sameJson(a.end, b.end) ? null : `not the same end (${a.end.kind} / ${b.end.kind})`;
}

/** What the record's own send says a door the upgrade adds answers; a verdict nobody recorded = excluded. */
function fromRecord(body, first) {
  let excluded = null;
  const special = (name, args) => {
    const send = (body.calls ?? []).find((c) => c.name === "email.send");
    if (first) {
      if (name === `provider:${EMAIL_FOUND_OUTCOME}`) {
        const r = readAnswerFromRecord({ id: "case", calls: body.calls ?? [] }, String(args?.query?.emails ?? ""));
        if ("excluded" in r) return { stop: (excluded = r.excluded) };
        return { v: r.answer };
      }
      if (name === VERIFY_DOOR) return { stop: "asked for a new verification, which no record holds" };
      if (name === SEND_CHECK_DOOR) return send && !send.answer.ok ? { v: send.answer } : { stop: "asked the send's check on an address the record's send accepted" };
      return undefined;
    }
    if (name !== INTRO_ANSWER_CHECK_DOOR) return undefined;
    if (!send) return { stop: (excluded = "the record reaches the check and holds no new email to the other person: what the send's door said is not recorded") };
    return { v: send.answer.ok ? { ok: true, data: { sendable: true } } : send.answer };
  };
  return { special, excluded: () => excluded };
}

const data = await load();
let failed = 0;
for (const [outcome, dynasty] of DYNASTIES) {
  const first = INTRO_FIRST_EMAILS.some((x) => x.outcome === outcome && x.dynasty === dynasty);
  if (!first && !INTRO_ANSWER_SENDERS.some((x) => x.outcome === outcome && x.dynasty === dynasty)) throw new Error(`${outcome}/${dynasty} is not an intro script this proof knows`);
  const active = data.scripts.find((s) => s.outcome === outcome && s.dynasty === dynasty);
  if (!active) throw new Error(`no active ${outcome}/${dynasty}`);
  const mark = first ? FIRST_MARK : INTRO_ANSWER_CHECK_MARK;
  if (active.code.includes(mark)) {
    log(`${outcome}/${dynasty}/v${active.version} already looks before writing: nothing to do`);
    continue;
  }
  const next = first ? addVerifyBeforeWrite(active.code, INTRO_FIRST_EMAIL_SHAPE) : addIntroAnswerCheck(active.code);
  await validateSource(next);
  if (!sameJson(readMaterials(next), readMaterials(active.code))) throw new Error(`${dynasty}: the upgrade does not read the same materials as the stored code`);
  const tactics = first ? verifyBeforeWriteTactics(active.tactics ?? {}) : introAnswerCheckTactics(active.tactics ?? {});
  const added = first ? [`provider:${EMAIL_FOUND_OUTCOME}`, VERIFY_DOOR, SEND_CHECK_DOOR] : [INTRO_ANSWER_CHECK_DOOR];
  const tactic = first ? `verdictMaxAgeDays=${tactics.verdictMaxAgeDays}` : `${INTRO_ANSWER_CHECK_TACTIC}=${tactics[INTRO_ANSWER_CHECK_TACTIC]}`;
  let bad = 0;

  // A port's recorded cases (the catalogue replays them at the upgrade too).
  const ported = data.scriptCases.filter((c) => c.outcome === outcome && c.dynasty === dynasty);
  const count = { cases: ported.length, unchanged: 0, sent: 0, refused: 0, excluded: 0, different: 0 };
  const restated = [];
  for (const row of ported) {
    const c = { ...row.body, id: row.body.id ?? row.caseId };
    if (!first) {
      restated.push(c);
      count.unchanged++;
      continue;
    }
    const r = await restateCaseForVerifyBeforeWrite(next, c, tactics, runScript);
    count[r.kind]++;
    if (r.kind === "different") log(`DIFFERENT ${row.caseId}: ${r.reason.slice(0, 300)}`);
    else if (r.kind === "excluded") log(`EXCLUDED ${row.caseId}: ${r.reason}`);
    else restated.push(r.case);
  }
  bad += count.different;
  if (restated.length > 0) {
    const summary = await replayAll(next, restated.map((c) => ({ ...c, tactics: first ? { ...tactics, ...(c.tactics ?? {}) } : (c.tactics ?? {}) })));
    if (summary.matches !== summary.cases) {
      for (const f of summary.failures.slice(0, 10)) log(`FAILS ${f.id}: ${f.diffs.slice(0, 2).join(" | ").slice(0, 400)}`);
      bad++;
    }
  }
  if (first && count.sent + count.refused + count.excluded > 0) {
    log(`${dynasty}: it holds port cases the rule restates: store it through upgradeWithCases (prove-verify-before-write.mjs's way), not this script's plain upgrade`);
    bad++;
  }

  // Production's recorded runs of the dynasty.
  const runs = data.writerCases.filter((c) => String(c.recordedFrom).startsWith(`${outcome}/${dynasty}/`));
  const seen = { runs: runs.length, unfit: 0, sameWithoutTactic: 0, neverReachesTheLook: 0, passed: 0, refused: 0, excluded: 0, different: 0 };
  for (const run of runs) {
    const body = run.body;
    // The script's own tactics, the run's on top (as the runner merges them; a record keeps the run's only).
    const own = { ...(active.tactics ?? {}), ...(body.tactics ?? {}) };
    const old = await replay(active.code, body, own, null);
    if (old.end.kind === "stopped") {
      seen.unfit++;
      log(`UNFIT ${run.id} (${run.recordedFrom}): the stored code does not replay it: ${old.end.reason.slice(0, 200)}`);
      continue;
    }
    const off = await replay(next, body, own, null);
    const offDiff = firstDiff(old, off, []);
    if (offDiff) {
      seen.different++;
      log(`DIFFERENT ${run.id} (tactic absent): ${offDiff}`);
      continue;
    }
    seen.sameWithoutTactic++;
    const rec = fromRecord(body, first);
    const on = await replay(next, body, first ? verifyBeforeWriteTactics(own) : introAnswerCheckTactics(own), rec.special);
    const looked = on.steps.some((s) => added.includes(s.name));
    if (rec.excluded()) {
      seen.excluded++;
      log(`EXCLUDED ${run.id}: ${rec.excluded()}`);
    } else if (on.end.kind === "stopped") {
      seen.different++;
      log(`DIFFERENT ${run.id} (tactic on): the upgrade does not replay it: ${on.end.reason.slice(0, 200)}`);
    } else if (!looked) {
      const d = firstDiff(old, on, added);
      if (d) {
        seen.different++;
        log(`DIFFERENT ${run.id} (tactic on, the look never reached): ${d}`);
      } else seen.neverReachesTheLook++;
    } else {
      const send = (body.calls ?? []).find((c) => c.name === "email.send");
      const wasRefused = Boolean(send && !send.answer.ok);
      if (wasRefused) {
        if (on.steps.some((s) => s.name === "email.send")) {
          seen.different++;
          log(`DIFFERENT ${run.id}: an address the record's send refused was still sent to`);
        } else seen.refused++;
      } else {
        const d = firstDiff(old, on, added);
        if (d) {
          seen.different++;
          log(`DIFFERENT ${run.id} (tactic on, passed): ${d}`);
        } else seen.passed++;
      }
    }
  }
  bad += seen.different;
  log(`${outcome}/${dynasty}/v${active.version} -> upgrade (${active.code.length} -> ${next.length} chars, tactic ${tactic}): port cases ${JSON.stringify(count)}; recorded runs ${JSON.stringify(seen)}`);
  if (bad > 0) {
    log(`${dynasty}: the upgrade does not run on every record as it must: nothing may be stored`);
    failed++;
    continue;
  }
  if (ops) console.log(JSON.stringify({ op: "upgrade", outcome, dynasty, fromVersion: active.version, code: next, tactics, skipIfIncludes: mark }));
}
process.exit(failed > 0 ? 1 : 0);
