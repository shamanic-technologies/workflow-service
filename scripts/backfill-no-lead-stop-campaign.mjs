/**
 * One-time repair: every stored lead-serving DAG tells campaign-service when its
 * run's audience came back empty (`stopCampaign: true` on `/end-run` for
 * `fetch-lead.found == false`). See src/lib/no-lead-stop-campaign.ts for why and
 * for the exact rewrite.
 *
 * Every version is repaired, not only the active heads, so a restored or
 * un-retired version cannot bring the bug back. Each rewritten DAG is
 * re-validated, its signature recomputed (a collision with another ACTIVE row of
 * the same feature refuses the write), the row is read back, and every ACTIVE
 * row that changed has its Windmill flow re-pushed right away — the flow is what
 * actually runs, and waiting for the next boot sync would leave live campaigns on
 * the old flow until then.
 *
 * Dry-run by default; idempotent (a second run changes nothing).
 *
 * Runs against the COMPILED code, so it can be executed inside the deployed
 * container, which carries the database and Windmill credentials:
 *   docker cp scripts/backfill-no-lead-stop-campaign.mjs <container>:/app/scripts/
 *   docker exec <container> node /app/scripts/backfill-no-lead-stop-campaign.mjs          # dry run
 *   docker exec <container> node /app/scripts/backfill-no-lead-stop-campaign.mjs --apply  # write
 * Locally: `npm run build` first.
 */

import { eq } from "drizzle-orm";
import { db, sql } from "../dist/db/index.js";
import { workflows } from "../dist/db/schema.js";
import { validateDAG } from "../dist/lib/dag-validator.js";
import { computeDAGSignature } from "../dist/lib/dag-signature.js";
import { applyNoLeadStopCampaign, planNoLeadStopCampaign } from "../dist/lib/no-lead-stop-campaign.js";
import { getWindmillClient } from "../dist/lib/windmill-client.js";
import { syncFlowToWindmill } from "../dist/lib/startup-validator.js";

const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (pass --apply to write) ===");
  const windmill = APPLY ? getWindmillClient() : null;
  if (APPLY && !windmill) throw new Error("Windmill client not configured — refusing to write DAGs it cannot sync");

  const all = await db.select().from(workflows);
  const activeSignatures = new Map();
  for (const w of all) if (w.status === "active") activeSignatures.set(`${w.featureSlug}::${w.signature}`, w.id);

  const counts = { written: 0, already: 0, skipped: 0, failed: 0, synced: 0 };

  for (const wf of all) {
    if (!wf.dag || !Array.isArray(wf.dag.nodes)) continue;
    const { dag, plan, changed } = applyNoLeadStopCampaign(wf.dag);
    if (plan.action === "already-signals") { counts.already++; continue; }
    if (plan.action === "skip") {
      if (plan.reason !== "no lead serve") {
        counts.skipped++;
        console.log(`  SKIP ${wf.workflowSlug} [${wf.status}/${wf.workflowDynastyStatus}] — ${plan.reason}`);
      }
      continue;
    }
    if (!changed) continue;

    const structural = validateDAG(dag);
    if (!structural.valid) {
      counts.failed++;
      console.error(`  REFUSED ${wf.workflowSlug} — ${structural.errors.map((e) => `${e.field}: ${e.message}`).join("; ")}`);
      continue;
    }

    const signature = computeDAGSignature(dag);
    if (wf.status === "active") {
      const holder = activeSignatures.get(`${wf.featureSlug}::${signature}`);
      if (holder && holder !== wf.id) {
        counts.failed++;
        console.error(`  REFUSED ${wf.workflowSlug} — signature already held by active workflow ${holder}`);
        continue;
      }
    }

    console.log(`  ${APPLY ? "WRITE" : "WOULD WRITE"} ${wf.workflowSlug} [${wf.status}/${wf.workflowDynastyStatus}] ${plan.action}`);
    if (!APPLY) { counts.written++; continue; }

    await db.update(workflows).set({ dag, signature, updatedAt: new Date() }).where(eq(workflows.id, wf.id));
    if (wf.status === "active") {
      activeSignatures.delete(`${wf.featureSlug}::${wf.signature}`);
      activeSignatures.set(`${wf.featureSlug}::${signature}`, wf.id);
    }

    const [reread] = await db.select().from(workflows).where(eq(workflows.id, wf.id));
    if (!reread || planNoLeadStopCampaign(reread.dag).action !== "already-signals") {
      counts.failed++;
      console.error(`  WRITE VERIFY FAILED ${wf.workflowSlug}`);
      continue;
    }
    counts.written++;

    if (reread.status === "active") {
      await syncFlowToWindmill(reread, windmill);
      counts.synced++;
    }
  }

  console.log(`\nDone. ${JSON.stringify(counts)}`);
  await sql.end();
  process.exit(counts.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
