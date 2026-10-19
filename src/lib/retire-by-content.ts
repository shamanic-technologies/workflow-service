import { summarizeContentGeneration } from "./content-generation-summary.js";
import type { DAG } from "./dag-validator.js";

// TEMPLATE-MODEL-STATUS-1019 (owner 2026-10-19): a workflow is retired because of the content-generation
// TEMPLATE it renders or the MODEL it writes with, so staff deprecate the template or the model and every
// workflow running it stops with it. Re-activating the template or model brings NO workflow back: the owner
// re-activates the ones he wants by hand.

export type ContentTarget = { promptType: string; model?: undefined } | { model: string; promptType?: undefined };

interface Row {
  status: string;
  workflowDynastyStatus: string;
  dag: unknown;
}

/** The RUNNABLE rows (version active, dynasty active) whose content call renders `promptType` / writes with `model`. */
export function rowsUsingContent<T extends Row>(rows: readonly T[], target: ContentTarget): T[] {
  return rows.filter((row) => {
    if (row.status !== "active" || row.workflowDynastyStatus !== "active") return false;
    const summary = summarizeContentGeneration(row.dag as DAG);
    return target.promptType !== undefined ? summary.contentPromptType === target.promptType : summary.contentModel === target.model;
  });
}
