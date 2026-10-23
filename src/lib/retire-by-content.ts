import { summarizeContentGeneration } from "./content-generation-summary.js";
import type { DAG } from "./dag-validator.js";
import { contentRefsOf } from "./deprecated-content.js";
import type { LegAssignment } from "./catalogue-client.js";

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

// RETIRE-BY-CONTENT-PER-LEG-1023 (owner 2026-10-23: « Il faut que la deprecation manuelle soit par pipe!! »): staff
// deprecate a writer model or template on ONE pipe (channel x leg), so only that pipe's workflows stop. Which leg a
// dynasty sits on is features-service's (its ACTIVE leg assignments); a dynasty also active on another leg of the
// channel is KEPT and said so: retiring it would stop it on that other pipe too.

export interface LegScoped<T> {
  /** Matched dynasties sitting ONLY on `legKey`: the ones a per-pipe retirement stops. */
  onLeg: Array<{ row: T; legKeys: string[] }>;
  /** Matched dynasties on `legKey` AND another leg: listed, never retired by a per-pipe call. */
  alsoOnOtherLegs: Array<{ row: T; legKeys: string[] }>;
}

export function scopeToLeg<T extends { workflowDynastySlug: string }>(
  matched: readonly T[],
  legKey: string,
  assignments: readonly LegAssignment[],
): LegScoped<T> {
  const legsOf = new Map<string, string[]>();
  for (const a of assignments) {
    if (a.state !== "active") continue;
    const legs = legsOf.get(a.workflowDynastySlug) ?? [];
    if (!legs.includes(a.legKey)) legs.push(a.legKey);
    legsOf.set(a.workflowDynastySlug, legs);
  }
  const out: LegScoped<T> = { onLeg: [], alsoOnOtherLegs: [] };
  for (const row of matched) {
    const legKeys = [...(legsOf.get(row.workflowDynastySlug) ?? [])].sort();
    if (!legKeys.includes(legKey)) continue;
    (legKeys.length === 1 ? out.onLeg : out.alsoOnOtherLegs).push({ row, legKeys });
  }
  return out;
}
