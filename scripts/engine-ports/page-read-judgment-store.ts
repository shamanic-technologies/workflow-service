/**
 * ENGINE-GET-ASK-1123: prints the catalogue writes that store the scripts of the Page read and Judgment made Engines
 * (one JSON line each), dry by construction: pipe them into the container's poster, which applies each idempotently.
 *   npx tsx scripts/engine-ports/page-read-judgment-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * A script already stored is upgraded to this code only when its active version differs.
 */
import { engineScripts } from "./page-read-judgment.js";

for (const s of engineScripts()) {
  console.log(JSON.stringify({ op: "create", body: { outcome: s.outcome, dynasty: s.dynasty, name: s.name, code: s.code, description: s.description, tactics: s.tactics } }));
}
