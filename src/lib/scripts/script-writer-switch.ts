/**
 * FACTORY-P3 fleet writer switch (owner 2026-10-29, « 3.B »: the WHOLE fleet, no per-brand canary): every workflow
 * whose DAG calls content-generation's writer (`POST /generate`) writes with the stored script
 * `message_written/dy_template_writer_full` instead, as an UPGRADE of its own dynasty (same dynasty, next version, never
 * a fork, never a per-brand rule).
 *
 * What content-generation did AROUND the completion stays there (its `src/lib/script-writer.ts`), so the one call
 * becomes three steps in the same place of the DAG:
 *
 *   <gen>-materials  content-generation POST /generate/materials: the same body as the writer call (every mapping,
 *                    every injected field); answers the script's `subject`, `units`, `tactics` (the leg's LLM pick),
 *                    or `existing` when the request is already answered (idempotency, one email per lead).
 *   <gen>-script     workflow POST /orgs/scripts/run (this service): the script on its own run, child of the workflow
 *                    run, `recordedBy: "content-generation"` (it declares nothing) and `trace: true`; skipped when
 *                    the materials answered `existing`.
 *   <gen>            content-generation POST /generate, UNCHANGED id, body and mappings + `written` (the script run)
 *                    and `units`: stores the row and declares the ONE message_written on the script's run; downstream
 *                    nodes keep reading `$ref:<gen>.output.*` exactly as before.
 *
 * Every reader of the writer call (template head, leg-best LLM, template contracts, pipe duplicates, features' leg
 * reader) still finds exactly one `/generate` node carrying the same mappings.
 */
import { eq } from "drizzle-orm";
import type { DAG, DAGNode } from "../dag-validator.js";
import { scriptSwitches, workflows } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";

export const SCRIPT_WRITER = { outcome: "message_written", dynasty: "dy_template_writer_full" } as const;
export const MATERIALS_PATH = "/generate/materials";
export const SCRIPT_RUN_PATH = "/orgs/scripts/run";
export const RECORDED_BY = "content-generation";

const isGenerate = (n: DAGNode) => n.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate";
const moduleId = (nodeId: string) => nodeId.replace(/-/g, "_");

export const materialsNodeId = (genId: string) => `${genId}-materials`;
export const scriptNodeId = (genId: string) => `${genId}-script`;

/** True when the DAG's writer call is recorded from the stored script writer. */
export function writesWithScript(dag: { nodes?: DAGNode[] } | null | undefined): boolean {
  const nodes = dag?.nodes ?? [];
  const gens = nodes.filter(isGenerate);
  return (
    gens.length === 1 &&
    gens[0].inputMapping?.["body.written"] === `$ref:${scriptNodeId(gens[0].id)}.output` &&
    nodes.some((n) => n.id === scriptNodeId(gens[0].id) && n.config?.path === SCRIPT_RUN_PATH)
  );
}

/** True when the DAG has exactly one content-generation writer call that is not yet switched. */
export function switchableToScript(dag: { nodes?: DAGNode[] } | null | undefined): boolean {
  return (dag?.nodes ?? []).filter(isGenerate).length === 1 && !writesWithScript(dag);
}

/**
 * The DAG writing with the stored script. Idempotent (a switched DAG comes back equal). Throws unless the DAG has
 * exactly one content-generation `/generate` call, or when a node id the switch needs is already taken.
 */
export function withScriptWriter(dag: DAG): DAG {
  if (writesWithScript(dag)) return dag;
  const gens = dag.nodes.filter(isGenerate);
  if (gens.length !== 1) throw new Error(`withScriptWriter: expected exactly one content-generation /generate call, found ${gens.length}`);
  const gen = gens[0];
  const mId = materialsNodeId(gen.id);
  const sId = scriptNodeId(gen.id);
  for (const id of [mId, sId]) if (dag.nodes.some((n) => n.id === id)) throw new Error(`withScriptWriter: node id "${id}" is already taken`);
  if (!dag.edges.some((e) => e.to === gen.id)) throw new Error(`withScriptWriter: "${gen.id}" has no incoming edge`);

  const materials: DAGNode = {
    ...gen,
    id: mId,
    config: { ...gen.config, path: MATERIALS_PATH },
    inputMapping: { ...(gen.inputMapping ?? {}) },
  };
  const script: DAGNode = {
    id: sId,
    type: "http.call",
    config: {
      service: "workflow",
      method: "POST",
      path: SCRIPT_RUN_PATH,
      body: { outcome: SCRIPT_WRITER.outcome, dynasty: SCRIPT_WRITER.dynasty, recordedBy: RECORDED_BY, trace: true },
      // The request is already answered (idempotency key, the lead's email for this campaign): nothing is written.
      skipIf: `results.${moduleId(mId)}?.existing != null`,
    },
    inputMapping: {
      "body.subject": `$ref:${mId}.output.subject`,
      "body.units": `$ref:${mId}.output.units`,
      "body.tactics": `$ref:${mId}.output.tactics`,
    },
    retries: 0,
  };
  const record: DAGNode = {
    ...gen,
    inputMapping: { ...(gen.inputMapping ?? {}), "body.written": `$ref:${sId}.output`, "body.units": `$ref:${mId}.output.units` },
  };

  // Every edge into the writer call now runs into the materials read (same sources, same conditions), so the three
  // steps sit exactly where the call sat; the call follows them.
  return {
    ...dag,
    nodes: dag.nodes.flatMap((n) => (n.id === gen.id ? [materials, script, record] : [n])),
    edges: [
      ...dag.edges.map((e) => (e.to === gen.id ? { ...e, to: mId } : e)),
      { from: mId, to: sId },
      { from: sId, to: gen.id },
    ],
  };
}

/**
 * Record a switch just made by `POST /workflows/upgrade` (the ops script `scripts/switch-writer-to-script.mjs`): the
 * upgraded version must write with the script and its predecessor (`created_from_workflow`, an UPGRADE in the same
 * dynasty) must be the content-generation writer it replaced. Idempotent per upgraded version.
 */
export async function recordSwitch(db: AnyPgDb, toWorkflowId: string) {
  const [to] = await db.select().from(workflows).where(eq(workflows.id, toWorkflowId));
  if (!to) throw new SwitchError(404, `workflow ${toWorkflowId} not found`);
  if (to.creationType !== "upgrade" || !to.createdFromWorkflow) throw new SwitchError(409, `${to.workflowSlug} is not an upgrade: a switch is an upgrade of its dynasty`);
  if (!writesWithScript(to.dag as DAG)) throw new SwitchError(409, `${to.workflowSlug} does not write with the stored script`);
  const [from] = await db.select().from(workflows).where(eq(workflows.id, to.createdFromWorkflow));
  if (!from || from.workflowDynastySlug !== to.workflowDynastySlug) throw new SwitchError(409, `${to.workflowSlug}: its predecessor is not in its dynasty`);
  if (!switchableToScript(from.dag as DAG)) throw new SwitchError(409, `${from.workflowSlug} is not a content-generation writer`);
  const [row] = await db
    .insert(scriptSwitches)
    .values({
      outcome: SCRIPT_WRITER.outcome,
      dynasty: SCRIPT_WRITER.dynasty,
      workflowDynastySlug: to.workflowDynastySlug,
      fromWorkflowId: from.id,
      fromVersion: from.version,
      toWorkflowId: to.id,
      toVersion: to.version,
    })
    .onConflictDoNothing({ target: scriptSwitches.toWorkflowId })
    .returning();
  return row ?? (await db.select().from(scriptSwitches).where(eq(scriptSwitches.toWorkflowId, to.id)))[0]!;
}

export class SwitchError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
