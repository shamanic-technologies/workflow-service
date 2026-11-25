/**
 * DISTRY-ENGINES-1119: prints the catalogue writes that give every Engine a runnable script (one JSON line each), dry by
 * construction: pipe them into the container's poster, which applies each idempotently.
 *   npx tsx scripts/engine-ports/distry-engines-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * The reasons of the Engines no script makes on demand are stated through `PUT /internal/engines/{outcome}/reason`
 * (`--reasons` prints them as `{outcome, reason}` lines instead).
 * `--first-email-paths` (PLAN-RECURSIVE-PER-ENGINE-1124-WF2) reads the ACTIVE scripts from a file (one JSON
 * `{outcome, tactics}` per line, from the box) and prints the first cold email path of every Engine reached by answering
 * a lead, plus the public paths (upgraded so an occurrence run is refused, by who).
 * `--public-act-paths <jsonl> <steps json> [--restore]` (WF3 B1): the paths through a public act (`publicActPaths`),
 * created RETIRED; `--restore` prints only the status ops that put them live; `--only <engine,...>` narrows to the paths
 * asking those Engines (each group restored once features-service's opt-in tactic for it exists).
 */
import { readFileSync } from "node:fs";
import { buildDraftSource, buildPathSource, buildReplySource, type CatalogueStep, DRAFTS, ENGINE_REASONS, firstEmailPaths, occurrenceActPaths, PATHS, PRODUCERS, publicActPaths, REPLIES } from "./distry-engines.js";
import { readRequestFields } from "../../src/lib/scripts/request-fields.js";

const out = (o: unknown) => console.log(JSON.stringify(o));
// `--only <engine,engine>`: the paths asking those Engines only (a group restored once its opt-in tactic exists).
const only = process.argv.includes("--only") ? new Set(String(process.argv[process.argv.indexOf("--only") + 1] ?? "").split(",").filter(Boolean)) : null;
const pathOp = (p: (typeof PATHS)[number]) => ({ op: "create", body: { outcome: p.outcome, dynasty: p.dynasty, name: p.name, code: buildPathSource(p.asks, { answersNobody: p.answersNobody === true }), description: p.description, tactics: p.tactics } });
if (process.argv.includes("--first-email-paths")) {
  const file = process.argv[process.argv.indexOf("--first-email-paths") + 1];
  if (!file) throw new Error("--first-email-paths <file>: the active scripts, one JSON {outcome, tactics} per line");
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { outcome: string; tactics: Record<string, unknown> | null });
  for (const p of [...firstEmailPaths(rows), ...PATHS.filter((x) => x.answersNobody)]) out(pathOp(p));
} else if (process.argv.includes("--public-act-paths")) {
  // PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B1: `--public-act-paths <active scripts jsonl> <catalogue steps json>`. Each is
  // created then RETIRED at once (`status` op): restored only once features-service's opt-in tactic for its act exists.
  const i = process.argv.indexOf("--public-act-paths");
  const [file, stepsFile] = [process.argv[i + 1], process.argv[i + 2]];
  if (!file || !stepsFile) throw new Error("--public-act-paths <active scripts jsonl> <catalogue steps json>");
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { outcome: string; tactics: Record<string, unknown> | null });
  const steps = (JSON.parse(readFileSync(stepsFile, "utf8")) as { rows: CatalogueStep[] }).rows;
  const status = process.argv.includes("--restore") ? "active" : "deprecated";
  for (const p of publicActPaths(rows, steps).filter((x) => only === null || only.has(x.asks))) {
    if (status === "deprecated") out(pathOp(p));
    out({ op: "status", outcome: p.outcome, dynasty: p.dynasty, status, reason: status === "deprecated" ? "Stored retired until features-service states the opt-in tactic of the act it works through (PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B1)" : "Restored: the opt-in tactic of its act is live (PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B1)" });
  }
} else if (process.argv.includes("--answer-through-paths")) {
  // WF3 B2-B4: `--answer-through-paths <active scripts jsonl WITH code> <catalogue steps json> [--restore]`, created
  // RETIRED (status op) until features-service's opt-in tactic per asked Engine exists.
  const i = process.argv.indexOf("--answer-through-paths");
  const [file, stepsFile] = [process.argv[i + 1], process.argv[i + 2]];
  if (!file || !stepsFile) throw new Error("--answer-through-paths <active scripts jsonl with code> <catalogue steps json>");
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { outcome: string; tactics: Record<string, unknown> | null; code: string });
  const steps = (JSON.parse(readFileSync(stepsFile, "utf8")) as { rows: CatalogueStep[] }).rows;
  const status = process.argv.includes("--restore") ? "active" : "deprecated";
  for (const p of occurrenceActPaths(rows, steps, readRequestFields).filter((x) => only === null || only.has(x.asks))) {
    if (status === "deprecated") out(pathOp(p));
    out({ op: "status", outcome: p.outcome, dynasty: p.dynasty, status, reason: status === "deprecated" ? "Stored retired until features-service states the opt-in tactic of the Engine it answers through (PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2-B4)" : "Restored: the opt-in tactic of the Engine it answers through is live (PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2-B4)" });
  }
} else if (process.argv.includes("--reasons")) {
  for (const [outcome, reason] of Object.entries(ENGINE_REASONS)) out({ outcome, reason });
} else {
  for (const p of PATHS) out(pathOp(p));
  const draft = buildDraftSource();
  for (const d of DRAFTS) out({ op: "create", body: { outcome: d.outcome, dynasty: d.dynasty, name: d.name, code: draft, description: d.description, tactics: d.tactics } });
  const reply = buildReplySource();
  for (const r of REPLIES) out({ op: "create", body: { outcome: r.outcome, dynasty: r.dynasty, name: r.name, code: reply, description: r.description, tactics: r.tactics } });
  for (const p of PRODUCERS) out({ op: "create", body: { outcome: p.outcome, dynasty: p.dynasty, name: p.name, code: p.build(), description: p.description, tactics: p.tactics } });
}
