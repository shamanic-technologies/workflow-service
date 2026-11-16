/**
 * ONE-WRITER-N-MODELS-1116 (owner 2026-11-16: « Je pensais qu'on avait qu'un script, et que le choix du model est
 * orthogonal / indépendant du script ??? »): a per-model copy of a writer is MERGED into what it now runs as. One copy
 * can count at several places: `email_sent/dy_cold_email_signed_sender_client_brand__claude_haiku__cresn` becomes the
 * free offer writer (Message written) asked by its sender, AND the model `llm_completion/dy_claude_haiku` asked by that
 * writer. Each place is one row: `{absorbed, survivor, askedBy}`.
 *
 * Non-destructive: the absorbed dynasty is retired (every version, with the reason), its runs keep their names, and
 * features-service pools its history into each survivor at its place (`GET /internal/scripts/merges`). An unmerge
 * restores the dynasty (its highest version) and closes its rows (kept, never deleted).
 */
import { and, asc, eq, isNull } from "drizzle-orm";
import { scriptMerges, scripts } from "../../db/schema.js";
import type { AnyPgDb } from "./script-catalogue.js";
import { ScriptCatalogueError, setDynastyStatus } from "./script-catalogue.js";

export interface ScriptRef {
  outcome: string;
  dynasty: string;
}

export interface MergePlace {
  survivor: ScriptRef;
  /** The script that asks the survivor at this place (`<outcome>/<dynasty>`), null = a campaign's own run. */
  askedBy: string | null;
}

export interface ServedMerge {
  absorbed: string;
  survivor: string;
  askedBy: string | null;
  reason: string;
  mergedBy: string;
  mergedAt: string;
}

const slug = (r: ScriptRef) => `${r.outcome}/${r.dynasty}`;

async function runnable(db: AnyPgDb, ref: ScriptRef): Promise<boolean> {
  const [row] = await db
    .select({ id: scripts.id })
    .from(scripts)
    .where(and(eq(scripts.outcome, ref.outcome), eq(scripts.dynasty, ref.dynasty), eq(scripts.status, "active"), eq(scripts.dynastyStatus, "active")));
  return Boolean(row);
}

async function openRows(db: AnyPgDb, absorbed: ScriptRef) {
  return db
    .select()
    .from(scriptMerges)
    .where(and(eq(scriptMerges.absorbedOutcome, absorbed.outcome), eq(scriptMerges.absorbedDynasty, absorbed.dynasty), isNull(scriptMerges.unmergedAt)));
}

/**
 * Merge `absorbed` into every place it now counts at. Refused (nothing written) when a survivor has no runnable
 * version, a place names the absorbed dynasty itself, the absorbed dynasty is already merged, or the reason is empty.
 */
export async function mergeScript(
  db: AnyPgDb,
  input: { absorbed: ScriptRef; places: MergePlace[]; reason: string; mergedBy: string },
): Promise<ServedMerge[]> {
  const reason = input.reason.trim();
  if (!reason) throw new ScriptCatalogueError(400, "merge_reason_required", "a merge states why");
  if (input.places.length === 0) throw new ScriptCatalogueError(400, "merge_places_required", "a merge names at least one survivor");
  const absorbed = slug(input.absorbed);
  for (const p of input.places) {
    if (slug(p.survivor) === absorbed) throw new ScriptCatalogueError(400, "merge_into_itself", `${absorbed} cannot be merged into itself`);
    if (!(await runnable(db, p.survivor))) throw new ScriptCatalogueError(409, "survivor_not_runnable", `${slug(p.survivor)} has no runnable version: merge into a script that runs`);
  }
  if ((await openRows(db, input.absorbed)).length > 0) throw new ScriptCatalogueError(409, "already_merged", `${absorbed} is already merged`);
  const into = input.places.map((p) => `${slug(p.survivor)}${p.askedBy ? ` (asked by ${p.askedBy})` : ""}`).join(", ");
  // The dynasty first: a refused retire (unknown dynasty) leaves no row behind.
  await setDynastyStatus(db, input.absorbed.outcome, input.absorbed.dynasty, "deprecated", `Merged into ${into}: ${reason}`);
  await db.insert(scriptMerges).values(
    input.places.map((p) => ({
      absorbedOutcome: input.absorbed.outcome,
      absorbedDynasty: input.absorbed.dynasty,
      survivorOutcome: p.survivor.outcome,
      survivorDynasty: p.survivor.dynasty,
      askedBy: p.askedBy,
      reason,
      mergedBy: input.mergedBy,
    })),
  );
  return (await listMerges(db)).filter((m) => m.absorbed === absorbed);
}

/** Undo a merge: the dynasty runs again (its highest version), its rows are closed (kept). */
export async function unmergeScript(db: AnyPgDb, absorbed: ScriptRef, reason: string): Promise<{ closed: number }> {
  if (!reason.trim()) throw new ScriptCatalogueError(400, "unmerge_reason_required", "an unmerge states why");
  const rows = await openRows(db, absorbed);
  if (rows.length === 0) throw new ScriptCatalogueError(404, "not_merged", `${slug(absorbed)} is not merged`);
  await setDynastyStatus(db, absorbed.outcome, absorbed.dynasty, "active", reason.trim());
  await db
    .update(scriptMerges)
    .set({ unmergedAt: new Date() })
    .where(and(eq(scriptMerges.absorbedOutcome, absorbed.outcome), eq(scriptMerges.absorbedDynasty, absorbed.dynasty), isNull(scriptMerges.unmergedAt)));
  return { closed: rows.length };
}

/** Every open merge, oldest first. */
export async function listMerges(db: AnyPgDb): Promise<ServedMerge[]> {
  const rows = await db.select().from(scriptMerges).where(isNull(scriptMerges.unmergedAt)).orderBy(asc(scriptMerges.mergedAt));
  return rows.map((r) => ({
    absorbed: `${r.absorbedOutcome}/${r.absorbedDynasty}`,
    survivor: `${r.survivorOutcome}/${r.survivorDynasty}`,
    askedBy: r.askedBy,
    reason: r.reason,
    mergedBy: r.mergedBy,
    mergedAt: r.mergedAt.toISOString(),
  }));
}
