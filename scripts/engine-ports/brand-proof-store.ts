/**
 * BRAND-PROOF-LOGOS-1121: prints the catalogue writes, one JSON line each, dry by construction: pipe them into the
 * container's poster (`scripts/post-catalogue-ops.mjs`), which applies each one idempotently.
 *   npx tsx scripts/engine-ports/brand-proof-store.ts | ssh box "docker exec -i -e ... <workflow-service> node scripts/post-catalogue-ops.mjs [--apply]"
 * Two Engines, one script each: Client past employer found / dy_client_past_employers, Press feature found /
 * dy_press_mailbox. Their outcomes are declared in features-service's catalogue (POST /internal/catalogue/steps).
 */
import { buildClientPastEmployersSource, buildPressMailboxSource, CLIENT_PAST_EMPLOYERS, PRESS_MAILBOX } from "./brand-proof.js";

const out = (o: unknown) => console.log(JSON.stringify(o));
for (const [s, code] of [
  [CLIENT_PAST_EMPLOYERS, buildClientPastEmployersSource()],
  [PRESS_MAILBOX, buildPressMailboxSource()],
] as const) {
  out({ op: "create", body: { outcome: s.outcome, dynasty: s.dynasty, name: s.name, code, description: s.description, tactics: s.tactics } });
}
