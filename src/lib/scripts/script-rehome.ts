/**
 * MIGRATE-1105 S5 (owner 2026-11-06, verbatim: « le QUOI c'est l'outcome, et il doit être toujours aussi fin que
 * possible »): a live script made under a FAMILY outcome with its channel as a tactic (conversation + tactic `channel`
 * sales-cold-email-outreach) moves onto its FINE outcome (the WHAT: a Threads post published, an email sent). One
 * generic move for every dynasty, never a per-outcome branch:
 *
 *   - an UPGRADE, never a fork: the next version of the SAME dynasty (version + 1, `created_from_script` = the active
 *     version), stored under the fine outcome; the tactic `channel` is dropped (the outcome says it now) unless the
 *     caller states the tactics;
 *   - proven first: the code replays 100 % of the dynasty's recorded cases (a port stays a port), and the cases move
 *     with it (copied under the fine outcome, so every later upgrade is held to them);
 *   - nothing un-switched, nothing newly switched: every campaign switch scope of the family Engine (one org, or every
 *     org) is copied onto the fine Engine in the SAME state (a rolled-back org stays rolled back, a switched one
 *     switched), the script's own stored state (`script_storage`) is copied, and its open waits move with it;
 *   - the family version stays ACTIVE: a campaign whose pipe still names the family Engine keeps finding it. Its
 *     successor goes live when the pipe names the fine outcome (features-service `PUT /internal/catalogue/pipes/{id}/
 *     outcome`); the family dynasty is retired only then (`PUT /scripts/dynasty/{outcome}/{dynasty}/status`).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { engineWaits, scriptCases, scriptStorage, scriptSwitches, scripts, type ScriptRow } from "../../db/schema.js";
import {
  ScriptCatalogueError,
  activeVersion,
  proveOnCases,
  type AnyPgDb,
  type Author,
  type CatalogueDeps,
} from "./script-catalogue.js";
import { validateSource } from "./sandbox.js";
import { CAMPAIGN_CALLER } from "./engine.js";

export interface RehomeInput {
  /** The fine outcome (a catalogue step). */
  toOutcome: string;
  /** Absent: the active version's code (the move changes nothing it does). */
  code?: string;
  description?: string;
  /** Absent: the active version's tactics without `channel`. */
  tactics?: Record<string, unknown>;
}

export interface RehomeResult {
  script: ScriptRow;
  from: { outcome: string; dynasty: string; version: number };
  casesCopied: number;
  storageRowsCopied: number;
  switchesCopied: Array<{ orgId: string | null; state: string }>;
  waitsMoved: number;
}

const withoutChannel = (t: Record<string, unknown>): Record<string, unknown> => {
  const { channel: _channel, ...rest } = t;
  return rest;
};

export async function rehomeScript(db: AnyPgDb, outcome: string, dynasty: string, input: RehomeInput, author: Author, deps: CatalogueDeps): Promise<RehomeResult> {
  const toOutcome = input.toOutcome;
  if (toOutcome === outcome) throw new ScriptCatalogueError(400, "same_outcome", `${outcome}/${dynasty} already makes ${outcome}: upgrade it instead`);
  if (!(await deps.isKnownOutcome(toOutcome))) {
    throw new ScriptCatalogueError(400, "unknown_outcome", `${toOutcome} is not a step of the features-service catalogue: declare the fine outcome first`);
  }
  const current = await activeVersion(db, outcome, dynasty);
  if (!current || current.dynastyStatus !== "active") throw new ScriptCatalogueError(404, "not_found", `no live version of ${outcome}/${dynasty} to re-home`);
  const [taken] = await db.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.outcome, toOutcome), eq(scripts.dynasty, dynasty))).limit(1);
  if (taken) throw new ScriptCatalogueError(409, "dynasty_exists", `${toOutcome}/${dynasty} exists: the dynasty is already re-homed (upgrade it there)`);

  const code = input.code ?? current.code;
  const tactics = input.tactics ?? withoutChannel(current.tactics as Record<string, unknown>);
  let read: Awaited<ReturnType<typeof validateSource>>;
  try {
    read = await validateSource(code);
  } catch (e) {
    throw new ScriptCatalogueError(400, "invalid_code", e instanceof Error ? e.message : String(e));
  }
  // Proven on the dynasty's own cases, exactly as an upgrade is (same cases, the new tactics under each case's).
  const summary = await proveOnCases(db, outcome, dynasty, code, tactics);
  if (summary && summary.matches !== summary.cases) {
    throw new ScriptCatalogueError(
      422,
      "replay_failed",
      `${outcome}/${dynasty} is a port: re-homed onto ${toOutcome} it matches ${summary.matches} of its ${summary.cases} recorded cases, every one must match`,
      { replay: { cases: summary.cases, matches: summary.matches, failures: summary.failures.slice(0, 5).map((f) => ({ id: f.id, diffs: f.diffs.slice(0, 3).map((d) => d.slice(0, 300)) })) } },
    );
  }
  const replay = summary ? { cases: summary.cases, matches: summary.matches } : null;
  const cases = await db.select().from(scriptCases).where(and(eq(scriptCases.outcome, outcome), eq(scriptCases.dynasty, dynasty)));

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(scripts)
      .values({
        outcome: toOutcome,
        dynasty,
        version: current.version + 1,
        code,
        materials: read.materials,
        vendors: read.vendors,
        tactics,
        description: input.description ?? current.description,
        creationType: "upgrade",
        createdFromScript: current.id,
        orgId: author.orgId,
        createdBy: author.createdBy,
        replay,
      })
      .returning();
    for (const c of cases) {
      await tx.insert(scriptCases).values({ outcome: toOutcome, dynasty, caseId: c.caseId, body: c.body, source: c.source }).onConflictDoNothing();
    }
    const storage = await tx.select().from(scriptStorage).where(eq(scriptStorage.outcome, outcome));
    for (const s of storage) {
      await tx.insert(scriptStorage).values({ ...s, outcome: toOutcome }).onConflictDoNothing();
    }
    // Every campaign switch scope (one org, or every org) of the family Engine, its LATEST row, in the same state.
    const rows = await tx
      .select()
      .from(scriptSwitches)
      .where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.callerService, CAMPAIGN_CALLER)))
      .orderBy(desc(scriptSwitches.switchedAt));
    const latest = new Map<string, (typeof rows)[number]>();
    for (const r of rows) if (!latest.has(r.orgId ?? "")) latest.set(r.orgId ?? "", r);
    const switchesCopied: RehomeResult["switchesCopied"] = [];
    for (const r of latest.values()) {
      const [own] = await tx
        .select({ id: scriptSwitches.id })
        .from(scriptSwitches)
        .where(
          and(
            eq(scriptSwitches.outcome, toOutcome),
            eq(scriptSwitches.callerService, CAMPAIGN_CALLER),
            r.orgId ? eq(scriptSwitches.orgId, r.orgId) : sql`${scriptSwitches.orgId} is null`,
          ),
        )
        .limit(1);
      if (own) continue;
      await tx.insert(scriptSwitches).values({
        outcome: toOutcome,
        dynasty,
        callerService: CAMPAIGN_CALLER,
        orgId: r.orgId,
        scriptVersion: row!.version,
        fromVersion: 0,
        toVersion: row!.version,
        state: r.state,
        switchedAt: r.switchedAt,
        rolledBackAt: r.rolledBackAt,
        rollbackReason: r.rollbackReason,
      });
      switchesCopied.push({ orgId: r.orgId, state: r.state });
    }
    // Its open waits resume under the fine Engine (the campaign's dispatch claims waits by the Engine it runs).
    const versions = await tx.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty)));
    const moved = versions.length
      ? await tx
          .update(engineWaits)
          .set({ outcome: toOutcome })
          .where(and(eq(engineWaits.outcome, outcome), inArray(engineWaits.scriptId, versions.map((v) => v.id)), inArray(engineWaits.status, ["waiting", "claimed"])))
          .returning({ id: engineWaits.id })
      : [];
    return {
      script: row!,
      from: { outcome, dynasty, version: current.version },
      casesCopied: cases.length,
      storageRowsCopied: storage.length,
      switchesCopied,
      waitsMoved: moved.length,
    };
  });
}
