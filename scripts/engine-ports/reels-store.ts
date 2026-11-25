/**
 * REELS-1124: prints the catalogue writes that store the Reels scripts (one JSON line each), dry by construction: pipe
 * them into the container's poster, which applies each idempotently (a script already stored is upgraded only when its
 * active version differs).
 *   npx tsx scripts/engine-ports/reels-store.ts [outcome,...] | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 */
import { engineScripts } from "./reels.js";

const only = process.argv[2] ? new Set(process.argv[2].split(",")) : null;
for (const s of engineScripts()) {
  if (only && !only.has(s.outcome)) continue;
  console.log(JSON.stringify({ op: "create", body: { outcome: s.outcome, dynasty: s.dynasty, name: s.name, code: s.code, description: s.description, tactics: s.tactics } }));
}
