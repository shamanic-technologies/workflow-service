import { eq, and, isNull, inArray } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import { workflows, workflowDynastyMerges, type Workflow, type WorkflowDynastyMerge } from "../db/schema.js";
import { stopExecutable } from "./executable-until.js";
import { recordDeprecation } from "./deprecation.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<PgQueryResultHKT, any, any>;

// TPL-DYNASTY-1021-WF (owner 2026-10-21): two workflow dynasties on the SAME pipe writing with the same template
// dynasty and the same model are one workflow. The duplicate is MERGED into the survivor, never across two pipes,
// and the merge is non-destructive and reversible:
// - no historical row is rewritten (runs, emails, leads keep the absorbed workflow's slug);
// - the absorbed dynasty is deprecated on both axes WITH the survivor as its successor (the merge row names it,
//   reads serve `mergedIntoDynastySlug`, and execute-by-slug forwards a held absorbed slug to the survivor);
// - `absorbedPriorState` keeps every absorbed version's status fields, so an un-merge restores them exactly.

/** The status fields of one version, as they were before the merge. */
export interface PriorVersionState {
  id: string;
  status: string;
  workflowDynastyStatus: string;
  executableUntil: string | null;
  executableUntilSource: string | null;
  deprecationReason: string | null;
  deprecatedBy: string | null;
  deprecatedAt: string | null;
}

export function snapshotVersion(w: Workflow): PriorVersionState {
  return {
    id: w.id,
    status: w.status,
    workflowDynastyStatus: w.workflowDynastyStatus,
    executableUntil: w.executableUntil ? w.executableUntil.toISOString() : null,
    executableUntilSource: w.executableUntilSource ?? null,
    deprecationReason: w.deprecationReason ?? null,
    deprecatedBy: w.deprecatedBy ?? null,
    deprecatedAt: w.deprecatedAt ? w.deprecatedAt.toISOString() : null,
  };
}

/** `.set()` fields restoring one version exactly as the snapshot recorded it. */
export function restoreVersionFields(s: PriorVersionState) {
  return {
    status: s.status,
    workflowDynastyStatus: s.workflowDynastyStatus,
    executableUntil: s.executableUntil ? new Date(s.executableUntil) : null,
    executableUntilSource: s.executableUntilSource,
    deprecationReason: s.deprecationReason,
    deprecatedBy: s.deprecatedBy,
    deprecatedAt: s.deprecatedAt ? new Date(s.deprecatedAt) : null,
  };
}

/** The deprecation reason every absorbed version states. */
export function mergeDeprecationReason(survivor: { workflowDynastyName: string; workflowDynastySlug: string }, reason: string): string {
  return `Merged into ${survivor.workflowDynastyName} (${survivor.workflowDynastySlug}): ${reason}`;
}

/** Why a merge is refused before anything is written, or null when it may proceed. */
export function mergeRefusal(input: {
  absorbedSlug: string;
  absorbed: Workflow[];
  survivor: Workflow[];
  absorbedLegs: string[];
  survivorLegs: string[];
  openMerges: Map<string, string>;
}): { status: number; code: string; error: string } | null {
  const { absorbedSlug, absorbed, survivor, absorbedLegs, survivorLegs, openMerges } = input;
  const survivorSlug = survivor[0].workflowDynastySlug;
  if (absorbedSlug === survivorSlug) return { status: 400, code: "merge_into_itself", error: "A dynasty cannot be merged into itself" };
  if (openMerges.has(absorbedSlug)) {
    return { status: 409, code: "already_merged", error: `${absorbedSlug} is already merged into ${openMerges.get(absorbedSlug)}` };
  }
  if (openMerges.has(survivorSlug)) {
    return { status: 409, code: "survivor_merged", error: `${survivorSlug} is itself merged into ${openMerges.get(survivorSlug)}: merge into that one` };
  }
  if (absorbed[0].featureSlug !== survivor[0].featureSlug) {
    return { status: 409, code: "merge_across_pipes", error: `${absorbedSlug} runs on ${absorbed[0].featureSlug}, ${survivorSlug} on ${survivor[0].featureSlug}: a merge never crosses two pipes` };
  }
  const a = [...absorbedLegs].sort();
  const s = [...survivorLegs].sort();
  if (a.length === 0 || s.length === 0 || a.join(",") !== s.join(",")) {
    return {
      status: 409,
      code: "merge_across_pipes",
      error: `${absorbedSlug} serves leg(s) [${a.join(", ") || "none"}], ${survivorSlug} serves [${s.join(", ") || "none"}]: a merge needs both on the same pipe`,
    };
  }
  if (!survivor.some((w) => w.status === "active" && w.workflowDynastyStatus === "active")) {
    return { status: 409, code: "survivor_not_executable", error: `${survivorSlug} has no executable version to absorb into` };
  }
  if (!absorbed.some((w) => w.status === "active" && w.workflowDynastyStatus === "active")) {
    return { status: 409, code: "absorbed_not_executable", error: `${absorbedSlug} has no executable version: nothing runs to merge` };
  }
  return null;
}

/** absorbed dynasty slug -> survivor dynasty slug, for every OPEN merge. */
export async function loadOpenMerges(database: AnyPgDb = db): Promise<Map<string, string>> {
  const rows = await database
    .select({ a: workflowDynastyMerges.absorbedDynastySlug, s: workflowDynastyMerges.survivorDynastySlug })
    .from(workflowDynastyMerges)
    .where(isNull(workflowDynastyMerges.unmergedAt));
  return new Map(rows.map((r) => [r.a, r.s]));
}

/**
 * The FINAL survivor of a dynasty through every open merge (A into B into C = C), or null when it is not merged.
 * A cycle cannot be written (a survivor that is itself merged is refused) and is guarded anyway.
 */
export function finalSurvivor(dynastySlug: string, openMerges: Map<string, string>): string | null {
  let current = openMerges.get(dynastySlug);
  if (!current) return null;
  const seen = new Set([dynastySlug]);
  while (openMerges.has(current) && !seen.has(current)) {
    seen.add(current);
    current = openMerges.get(current)!;
  }
  return current;
}

export function formatMerge(m: WorkflowDynastyMerge, openMerges: Map<string, string>) {
  return {
    id: m.id,
    absorbedDynastySlug: m.absorbedDynastySlug,
    survivorDynastySlug: m.survivorDynastySlug,
    finalSurvivorDynastySlug: m.unmergedAt ? null : finalSurvivor(m.absorbedDynastySlug, openMerges),
    featureSlug: m.featureSlug,
    legKeys: m.legKeys as string[],
    reason: m.reason,
    decidedBy: m.decidedBy ?? null,
    mergedAt: m.mergedAt.toISOString(),
    unmergedAt: m.unmergedAt ? m.unmergedAt.toISOString() : null,
    unmergedBy: m.unmergedBy ?? null,
    unmergeReason: m.unmergeReason ?? null,
  };
}

/** Write a merge: the record (with every absorbed version's prior state) and the deprecation, in one transaction. */
export async function applyMerge(
  database: AnyPgDb,
  p: { absorbed: Workflow[]; survivor: Workflow[]; legKeys: string[]; reason: string; decidedBy: string | null },
): Promise<WorkflowDynastyMerge> {
  const absorbedSlug = p.absorbed[0].workflowDynastySlug;
  const deprecationReason = mergeDeprecationReason(p.survivor[0], p.reason);
  return database.transaction(async (tx) => {
    const [merge] = await tx
      .insert(workflowDynastyMerges)
      .values({
        absorbedDynastySlug: absorbedSlug,
        survivorDynastySlug: p.survivor[0].workflowDynastySlug,
        featureSlug: p.absorbed[0].featureSlug,
        legKeys: [...p.legKeys].sort(),
        reason: p.reason,
        decidedBy: p.decidedBy,
        absorbedPriorState: p.absorbed.map(snapshotVersion),
      })
      .returning();
    // Both axes deprecated, the stop recorded (an earlier one kept), the survivor named in the reason. A version
    // already deprecated before keeps its own reason in the snapshot, restored on un-merge.
    await tx
      .update(workflows)
      .set({
        status: "deprecated",
        workflowDynastyStatus: "deprecated",
        ...stopExecutable(),
        ...recordDeprecation({ reason: deprecationReason, decidedBy: p.decidedBy }),
        updatedAt: new Date(),
      })
      .where(eq(workflows.workflowDynastySlug, absorbedSlug));
    return merge;
  });
}

/** The open merge of an absorbed dynasty, or undefined. */
export async function openMergeOf(database: AnyPgDb, absorbedSlug: string): Promise<WorkflowDynastyMerge | undefined> {
  const [open] = await database
    .select()
    .from(workflowDynastyMerges)
    .where(and(eq(workflowDynastyMerges.absorbedDynastySlug, absorbedSlug), isNull(workflowDynastyMerges.unmergedAt)));
  return open;
}

/** The absorbed versions an open merge recorded, as they are now (a missing one cannot be restored exactly). */
export async function recordedVersions(database: AnyPgDb, merge: WorkflowDynastyMerge): Promise<{ prior: PriorVersionState[]; rows: Map<string, Workflow> }> {
  const prior = merge.absorbedPriorState as PriorVersionState[];
  const rows = await database.select().from(workflows).where(inArray(workflows.id, prior.map((v) => v.id)));
  return { prior, rows: new Map(rows.map((r) => [r.id, r])) };
}

/** Undo a merge: every recorded version back to its exact prior state, the record closed (kept). One transaction. */
export async function applyUnmerge(
  database: AnyPgDb,
  merge: WorkflowDynastyMerge,
  p: { reason: string; decidedBy: string | null },
): Promise<WorkflowDynastyMerge> {
  const prior = merge.absorbedPriorState as PriorVersionState[];
  return database.transaction(async (tx) => {
    for (const v of prior) {
      await tx.update(workflows).set({ ...restoreVersionFields(v), updatedAt: new Date() }).where(eq(workflows.id, v.id));
    }
    const [closed] = await tx
      .update(workflowDynastyMerges)
      .set({ unmergedAt: new Date(), unmergedBy: p.decidedBy, unmergeReason: p.reason })
      .where(eq(workflowDynastyMerges.id, merge.id))
      .returning();
    return closed;
  });
}
