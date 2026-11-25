/**
 * DISTRY-ENGINES-1119: prints the catalogue writes that give every Engine a runnable script (one JSON line each), dry by
 * construction: pipe them into the container's poster, which applies each idempotently.
 *   npx tsx scripts/engine-ports/distry-engines-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * The reasons of the Engines no script makes on demand are stated through `PUT /internal/engines/{outcome}/reason`
 * (`--reasons` prints them as `{outcome, reason}` lines instead).
 * `--first-email-paths` (PLAN-RECURSIVE-PER-ENGINE-1124-WF2) reads the ACTIVE scripts from a file (one JSON
 * `{outcome, tactics}` per line, from the box) and prints the first cold email path of every Engine reached by answering
 * a lead, plus the public paths (upgraded so an occurrence run is refused, by who).
 */
import { readFileSync } from "node:fs";
import { buildDraftSource, buildPathSource, buildReplySource, DRAFTS, ENGINE_REASONS, firstEmailPaths, PATHS, PRODUCERS, REPLIES } from "./distry-engines.js";

const out = (o: unknown) => console.log(JSON.stringify(o));
const pathOp = (p: (typeof PATHS)[number]) => ({ op: "create", body: { outcome: p.outcome, dynasty: p.dynasty, name: p.name, code: buildPathSource(p.asks, { answersNobody: p.answersNobody === true }), description: p.description, tactics: p.tactics } });
if (process.argv.includes("--first-email-paths")) {
  const file = process.argv[process.argv.indexOf("--first-email-paths") + 1];
  if (!file) throw new Error("--first-email-paths <file>: the active scripts, one JSON {outcome, tactics} per line");
  const rows = readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as { outcome: string; tactics: Record<string, unknown> | null });
  for (const p of [...firstEmailPaths(rows), ...PATHS.filter((x) => x.answersNobody)]) out(pathOp(p));
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
