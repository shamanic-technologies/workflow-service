import { and, eq, inArray } from "drizzle-orm";
import type { DAG, DAGNode } from "./dag-validator.js";
import { db } from "../db/index.js";
import { workflows, type Workflow } from "../db/schema.js";
import { literalBodyValue } from "./content-generation-summary.js";
import { templateDynastyOf } from "./template-dynasty.js";
import { fetchTemplateDynasties, type TemplateDynasty } from "./content-generation-client.js";
import { listLegAssignments } from "./catalogue-client.js";

// TPL-DYNASTY-1021-WF (owner 2026-10-21): within one pipe (channel x leg), two ACTIVE workflow dynasties writing
// with the same template dynasty and the same writer model are one workflow. A creation, upgrade or fork that would
// make a second one is refused (409 `duplicate_on_pipe`, naming the twin). An existing duplicate is merged
// (dynasty-merge.ts), never left running beside its twin.

export interface PipeWriter {
  templateDynasty: string;
  /** null = the DAG names no model (content-generation's own default). */
  model: string | null;
}

const isGenerate = (n: DAGNode) => n.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate";

/**
 * Which template dynasty + model a DAG writes with on one pipe: the dynasty it reads the head of, else the dynasty of
 * that pipe whose versions hold the template it pins. Null when it writes no email, several, or a template no dynasty
 * of this pipe holds (nothing to compare).
 */
export function writerOf(dag: DAG, dynastiesOnLeg: TemplateDynasty[]): PipeWriter | null {
  const gens = dag.nodes.filter(isGenerate);
  if (gens.length !== 1) return null;
  const model = literalBodyValue(gens[0], "model");
  const stated = templateDynastyOf(dag);
  if (stated) return { templateDynasty: stated, model };
  const type = literalBodyValue(gens[0], "type");
  const holder = type ? dynastiesOnLeg.find((d) => d.versions.some((v) => v.type === type)) : undefined;
  return holder ? { templateDynasty: holder.slug, model } : null;
}

export interface PipeDuplicate {
  legKey: string;
  templateDynasty: string;
  model: string | null;
  twinDynastySlug: string;
  twinWorkflowSlug: string;
}

export interface PipeDuplicateDeps {
  listAssignments: typeof listLegAssignments;
  listTemplateDynasties: typeof fetchTemplateDynasties;
  loadExecutable: (featureSlug: string, dynastySlugs: string[]) => Promise<Workflow[]>;
}

const defaultDeps: PipeDuplicateDeps = {
  listAssignments: listLegAssignments,
  listTemplateDynasties: fetchTemplateDynasties,
  loadExecutable: async (featureSlug, dynastySlugs) =>
    dynastySlugs.length === 0
      ? []
      : db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.featureSlug, featureSlug),
              inArray(workflows.workflowDynastySlug, dynastySlugs),
              eq(workflows.status, "active"),
              eq(workflows.workflowDynastyStatus, "active"),
            ),
          ),
};

/**
 * The active dynasty on one of `legKeys` that writes like `dag` (same template dynasty, same model), or null.
 * `ownDynastySlug` (an upgrade's own lineage) is never its own twin. A DAG writing no email costs no read at all;
 * otherwise a failed read throws: a write is never let through on a guess.
 */
export async function findPipeDuplicate(
  p: { featureSlug: string; legKeys: string[]; dag: DAG; ownDynastySlug?: string },
  deps: PipeDuplicateDeps = defaultDeps,
): Promise<PipeDuplicate | null> {
  if (p.legKeys.length === 0 || p.dag.nodes.filter(isGenerate).length !== 1) return null;
  let assignments: Awaited<ReturnType<typeof listLegAssignments>> | null = null;
  for (const legKey of p.legKeys) {
    const dynasties = await deps.listTemplateDynasties(p.featureSlug, legKey);
    const mine = writerOf(p.dag, dynasties);
    if (!mine) continue;
    assignments ??= await deps.listAssignments(p.featureSlug);
    const others = [
      ...new Set(
        assignments
          .filter((a) => a.legKey === legKey && a.state === "active" && a.workflowDynastySlug !== p.ownDynastySlug)
          .map((a) => a.workflowDynastySlug),
      ),
    ];
    for (const row of await deps.loadExecutable(p.featureSlug, others)) {
      const theirs = writerOf(row.dag as DAG, dynasties);
      if (theirs && theirs.templateDynasty === mine.templateDynasty && theirs.model === mine.model) {
        return { legKey, templateDynasty: mine.templateDynasty, model: mine.model, twinDynastySlug: row.workflowDynastySlug, twinWorkflowSlug: row.workflowSlug };
      }
    }
  }
  return null;
}

export function pipeDuplicateBody(d: PipeDuplicate) {
  return {
    error:
      `${d.twinWorkflowSlug} already writes with template dynasty "${d.templateDynasty}" and model "${d.model ?? "default"}" on leg ${d.legKey}: ` +
      `one pipe runs one workflow per template dynasty and model. Upgrade that one instead.`,
    code: "duplicate_on_pipe",
    twinWorkflowDynastySlug: d.twinDynastySlug,
    twinWorkflowSlug: d.twinWorkflowSlug,
  };
}

/** Answers 409 and returns true when the write would make a duplicate on its pipe. */
export async function refuseIfPipeDuplicate(
  res: import("express").Response,
  p: { featureSlug: string; legKeys: string[]; dag: DAG; ownDynastySlug?: string },
): Promise<boolean> {
  const dup = await findPipeDuplicate(p);
  if (!dup) return false;
  res.status(409).json(pipeDuplicateBody(dup));
  return true;
}
