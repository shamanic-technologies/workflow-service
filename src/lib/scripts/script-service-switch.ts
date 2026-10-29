/**
 * FACTORY-P3 next outcomes: a SERVICE switch. Some outcomes are made by a service inside its own code, with no
 * workflow step calling them (the reply judge: instantly-service judges every reply its poller and sweeps read). There
 * is no workflow dynasty to upgrade, so the switch lives here as one row per (outcome, caller service): while it is
 * `switched`, that service calls the stored script door (`POST /internal/scripts/run`) in place of its own code, and
 * keeps doing everything around the call (its records, its one outcome declaration per occurrence). The roll-back
 * guard (script-guard.ts) flips the row to `rolled_back` exactly as it re-activates a workflow's previous version; the
 * service reads the state (`GET /internal/scripts/switches/service`, cached a minute there) and is back on its own code.
 *
 * A switch is refused unless the dynasty's active version is a proven port (it replays 100 % of its recorded cases):
 * the same bar the runner holds a live run to.
 */
import { and, desc, eq } from "drizzle-orm";
import { scriptSwitches } from "../../db/schema.js";
import { activeVersion, caseCount, type AnyPgDb } from "./script-catalogue.js";
import { SwitchError } from "./script-writer-switch.js";

/** The services that may switch an outcome they make in their own code (one entry per service that ships its door). */
export const SERVICE_CALLERS = ["instantly", "apollo"] as const;
export type ServiceCaller = (typeof SERVICE_CALLERS)[number];

/** How a service switch is named where workflow switches name their dynasty (Monitoring, roll-back by name). */
export const serviceSwitchLabel = (callerService: string) => `service:${callerService}`;

export async function switchService(db: AnyPgDb, input: { outcome: string; dynasty: string; callerService: string }) {
  if (!(SERVICE_CALLERS as readonly string[]).includes(input.callerService)) {
    throw new SwitchError(400, `${input.callerService} is not a service that calls a stored script (known: ${SERVICE_CALLERS.join(", ")})`);
  }
  const row = await activeVersion(db, input.outcome, input.dynasty);
  if (!row) throw new SwitchError(404, `no active version of ${input.outcome}/${input.dynasty}`);
  const cases = await caseCount(db, input.outcome, input.dynasty);
  if (cases === 0 || !row.replay || row.replay.cases !== cases || row.replay.matches !== cases) {
    throw new SwitchError(409, `${input.outcome}/${input.dynasty}/v${row.version} is not a proven port (${row.replay?.matches ?? 0}/${cases} recorded cases): a switch needs 100 %`);
  }
  const [live] = await db
    .select()
    .from(scriptSwitches)
    .where(and(eq(scriptSwitches.outcome, input.outcome), eq(scriptSwitches.callerService, input.callerService), eq(scriptSwitches.state, "switched")));
  if (live) {
    if (live.dynasty !== input.dynasty) throw new SwitchError(409, `${input.outcome} is already switched to ${live.dynasty} for ${input.callerService}`);
    return live;
  }
  const [created] = await db
    .insert(scriptSwitches)
    .values({ outcome: input.outcome, dynasty: input.dynasty, callerService: input.callerService, scriptVersion: row.version, fromVersion: 0, toVersion: row.version })
    .returning();
  return created!;
}

/** What a caller service reads before each call: run the stored script, or its own code. */
export async function serviceSwitchState(db: AnyPgDb, outcome: string, callerService: string) {
  const [latest] = await db
    .select()
    .from(scriptSwitches)
    .where(and(eq(scriptSwitches.outcome, outcome), eq(scriptSwitches.callerService, callerService)))
    .orderBy(desc(scriptSwitches.switchedAt))
    .limit(1);
  const switched = latest?.state === "switched";
  return {
    outcome,
    callerService,
    switched,
    dynasty: switched ? latest!.dynasty : null,
    scriptVersion: switched ? (latest!.scriptVersion ?? null) : null,
    switchedAt: latest?.switchedAt?.toISOString() ?? null,
    rolledBackAt: latest?.rolledBackAt?.toISOString() ?? null,
    rollbackReason: latest?.rollbackReason ?? null,
  };
}
