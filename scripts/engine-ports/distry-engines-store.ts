/**
 * DISTRY-ENGINES-1119: prints the catalogue writes that give every Engine a runnable script (one JSON line each), dry by
 * construction: pipe them into the container's poster, which applies each idempotently.
 *   npx tsx scripts/engine-ports/distry-engines-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * The reasons of the Engines no script makes on demand are stated through `PUT /internal/engines/{outcome}/reason`
 * (`--reasons` prints them as `{outcome, reason}` lines instead).
 */
import { buildDraftSource, buildPathSource, buildReplySource, DRAFTS, ENGINE_REASONS, PATHS, PRODUCERS, REPLIES } from "./distry-engines.js";

const out = (o: unknown) => console.log(JSON.stringify(o));
if (process.argv.includes("--reasons")) {
  for (const [outcome, reason] of Object.entries(ENGINE_REASONS)) out({ outcome, reason });
} else {
  for (const p of PATHS) out({ op: "create", body: { outcome: p.outcome, dynasty: p.dynasty, name: p.name, code: buildPathSource(p.asks), description: p.description, tactics: p.tactics } });
  const draft = buildDraftSource();
  for (const d of DRAFTS) out({ op: "create", body: { outcome: d.outcome, dynasty: d.dynasty, name: d.name, code: draft, description: d.description, tactics: d.tactics } });
  const reply = buildReplySource();
  for (const r of REPLIES) out({ op: "create", body: { outcome: r.outcome, dynasty: r.dynasty, name: r.name, code: reply, description: r.description, tactics: r.tactics } });
  for (const p of PRODUCERS) out({ op: "create", body: { outcome: p.outcome, dynasty: p.dynasty, name: p.name, code: p.build(), description: p.description, tactics: p.tactics } });
}
