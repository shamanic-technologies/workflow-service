/**
 * One-time backfill: make every stored workflow STATE the content model it
 * already runs on.
 *
 * A workflow whose content-generation `/generate` node names no `model` runs on
 * content-generation-service's own default — `DEFAULT_MODEL: ChatModel = "pro"`
 * in that repo's `src/lib/chat-models.ts` — and nobody says so anywhere. The
 * catalogue read derives `contentModel` from the DAG (src/lib/content-generation-summary.ts),
 * so those rows serve `contentModel: null` and the customer dashboard renders an
 * em dash on a workflow that has a model like any other. The fix belongs to the
 * DATA, never to the read path: a consumer must not fabricate another service's
 * default, so a DAG that names no model must keep serving null.
 *
 * Every version is repaired, not only the active head, so a dynasty's history
 * reads consistently. Nodes that already state a model, that take it from a
 * `$ref` produced at run time, or whose whole body is supplied by an
 * inputMapping are left byte-identical (see src/lib/content-model-statement.ts).
 *
 * The rewritten DAG is re-validated structurally, and the diff is asserted to be
 * the single added key before anything is written. The signature is recomputed
 * so it keeps describing the stored DAG; a recomputed signature that would
 * collide with another ACTIVE row of the same feature refuses the write rather
 * than violating idx_workflows_active_sig.
 *
 * Idempotent and resumable: a second run reports zero changes.
 *
 * Usage:
 *   WORKFLOW_SERVICE_DATABASE_URL=postgresql://... \
 *   npx tsx scripts/backfill-content-model.ts --dry-run
 *
 * Drop --dry-run to write. --model <alias> overrides the value written (default
 * "pro"); --feature <slug> narrows the sweep to one feature.
 */

import { eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { workflows } from "../src/db/schema.js";
import { validateDAG, type DAG } from "../src/lib/dag-validator.js";
import { computeDAGSignature } from "../src/lib/dag-signature.js";
import {
  applyStatedContentModel,
  CONTENT_GENERATION_DEFAULT_MODEL,
  MODEL_BODY_FIELD,
} from "../src/lib/content-model-statement.js";
import { summarizeContentGeneration } from "../src/lib/content-generation-summary.js";

const DRY_RUN = process.argv.includes("--dry-run");

function argValue(flag: string): string | null {
  const i = process.argv.indexOf(flag);
  return i === -1 ? null : (process.argv[i + 1] ?? null);
}

const MODEL = argValue("--model") ?? CONTENT_GENERATION_DEFAULT_MODEL;
const FEATURE = argValue("--feature");

async function main() {
  console.log(DRY_RUN ? "=== DRY RUN ===" : "=== LIVE BACKFILL ===");
  console.log(`Model written where none is stated: ${MODEL}`);

  const all = await db.select().from(workflows);
  const rows = FEATURE ? all.filter((w) => w.featureSlug === FEATURE) : all;

  // An ACTIVE row's signature must stay unique per feature; collect what is
  // taken so a recomputed one cannot collide.
  const activeSignatures = new Map<string, string>();
  for (const w of all) {
    if (w.status === "active") activeSignatures.set(`${w.featureSlug}::${w.signature}`, w.id);
  }

  let written = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (const wf of rows) {
    const before = wf.dag as DAG;
    if (!before || !Array.isArray(before.nodes)) continue;

    const { dag: after, plans, changed } = applyStatedContentModel(before, MODEL);
    if (plans.length === 0) continue; // no content call at all

    for (const plan of plans) {
      if (plan.action === "add") {
        console.log(
          `  ${wf.workflowSlug} [${wf.status}] [${plan.nodeId}] + body.${MODEL_BODY_FIELD} = ${plan.model}`,
        );
      } else if (plan.action === "skip") {
        console.log(`  ${wf.workflowSlug} [${plan.nodeId}] SKIP — ${plan.reason}`);
      }
    }

    if (!changed) {
      if (plans.some((p) => p.action === "skip")) skipped++;
      else unchanged++;
      continue;
    }

    const structural = validateDAG(after);
    if (!structural.valid) {
      failed++;
      console.error(
        `  ${wf.workflowSlug} REFUSED — rewritten DAG fails validation: ` +
          structural.errors.map((e) => `${e.field}: ${e.message}`).join("; "),
      );
      continue;
    }

    // Nothing but the model key may change — and only on the nodes the plan
    // ADDED it to, so a DAG whose other content call already stated the same
    // alias still compares equal.
    const addedTo = new Set(plans.filter((p) => p.action === "add").map((p) => p.nodeId));
    const stripped = structuredClone(after);
    for (const node of stripped.nodes) {
      if (!addedTo.has(node.id)) continue;
      const body = node.config?.body as Record<string, unknown> | undefined;
      if (!body) continue;
      delete body[MODEL_BODY_FIELD];
      if (Object.keys(body).length === 0) delete (node.config as Record<string, unknown>).body;
    }
    const strippedBefore = structuredClone(before);
    for (const node of strippedBefore.nodes) {
      if (!addedTo.has(node.id)) continue;
      const body = node.config?.body as Record<string, unknown> | undefined;
      if (body && Object.keys(body).length === 0) delete (node.config as Record<string, unknown>).body;
    }
    if (JSON.stringify(stripped) !== JSON.stringify(strippedBefore)) {
      failed++;
      console.error(`  ${wf.workflowSlug} REFUSED — rewrite changed more than body.${MODEL_BODY_FIELD}`);
      continue;
    }

    const signature = computeDAGSignature(after);
    if (wf.status === "active") {
      const holder = activeSignatures.get(`${wf.featureSlug}::${signature}`);
      if (holder && holder !== wf.id) {
        failed++;
        console.error(
          `  ${wf.workflowSlug} REFUSED — recomputed signature already held by another active workflow (${holder})`,
        );
        continue;
      }
    }

    if (DRY_RUN) {
      written++;
      continue;
    }

    await db
      .update(workflows)
      .set({ dag: after, signature, updatedAt: new Date() })
      .where(eq(workflows.id, wf.id));

    if (wf.status === "active") {
      activeSignatures.delete(`${wf.featureSlug}::${wf.signature}`);
      activeSignatures.set(`${wf.featureSlug}::${signature}`, wf.id);
    }

    // Read back what landed rather than trusting the write.
    const [reread] = await db.select().from(workflows).where(eq(workflows.id, wf.id));
    if (!reread || summarizeContentGeneration(reread.dag as DAG).contentModel !== MODEL) {
      failed++;
      console.error(`  ${wf.workflowSlug} WRITE VERIFY FAILED — row does not state the model`);
      continue;
    }
    written++;
  }

  // Authoritative counts, read back from the database.
  const verify = (await db.select().from(workflows))
    .filter((w) => (FEATURE ? w.featureSlug === FEATURE : true))
    .filter((w) => w.status === "active")
    .filter((w) => (w.dag as DAG)?.nodes?.some(
      (n) => n.config?.service === "content-generation" && n.config?.path === "/generate",
    ));
  const stating = verify.filter(
    (w) => summarizeContentGeneration(w.dag as DAG).contentModel !== null,
  ).length;

  console.log(
    `\nDone. ${DRY_RUN ? "Would write" : "Wrote"}: ${written}, already stated: ${unchanged}, ` +
      `skipped: ${skipped}, failed: ${failed}`,
  );
  console.log(
    `DB now: ${stating}/${verify.length} active workflows with a content call state a model`,
  );

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
