import { summarizeContentGeneration } from "./content-generation-summary.js";
import type { DAG } from "./dag-validator.js";
import { contentRefsOf } from "./deprecated-content.js";

// TEMPLATE-MODEL-STATUS-1019 (owner 2026-10-19): a workflow is retired because of the content-generation
// TEMPLATE it renders or the MODEL it writes with, so staff deprecate the template or the model and every
// workflow running it stops with it. Re-activating the template or model brings NO workflow back: the owner
// re-activates the ones he wants by hand.
// A workflow writing with a template DYNASTY (its live head each run) is never matched by a template type
// (TPL-DYNASTY-1021-WF3, owner 2026-10-21: every non-head version is deprecated "Upgraded"): it stops only with the
// whole template dynasty or by its own status. Only a workflow PINNING the version is retired by it.

export type ContentTarget = { promptType: string; model?: undefined } | { model: string; promptType?: undefined };

interface Row {
  status: string;
  workflowDynastyStatus: string;
  dag: unknown;
}

/** The RUNNABLE rows (version active, dynasty active) whose content call pins `promptType` / writes with `model`. */
export function rowsUsingContent<T extends Row>(rows: readonly T[], target: ContentTarget): T[] {
  return rows.filter((row) => {
    if (row.status !== "active" || row.workflowDynastyStatus !== "active") return false;
    if (target.promptType !== undefined) {
      const pinned = new Set(contentRefsOf(row.dag as DAG).map((r) => r.promptType).filter((t): t is string => t !== null));
      return pinned.size === 1 && pinned.has(target.promptType);
    }
    return summarizeContentGeneration(row.dag as DAG).contentModel === target.model;
  });
}
