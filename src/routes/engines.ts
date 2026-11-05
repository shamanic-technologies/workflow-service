/**
 * MIGRATE-1105 S0: the door a campaign run takes to its ENGINE (stored scripts), with no workflow.
 *
 *   GET  /internal/engines/{outcome}?orgId=     is this Engine live for this org's campaigns (campaign-service reads it)
 *   POST /engines/{outcome}/execute             run it for one campaign dispatch (same identity/admission as a workflow)
 *   POST /internal/engines/{outcome}/switch     switch it on for one org, or every org (staff / the migration steps)
 *   POST /internal/engines/{outcome}/off        switch it off for one org, or every org
 *
 * Mounted before the identity gate: the execute route checks its own headers (and never needs `x-workflow-slug`).
 */
import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { type WorkflowRun } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { executeRateLimit } from "../middleware/rate-limit.js";
import { zodErrorDetails } from "../lib/zod-error-details.js";
import { EngineExecuteRequestSchema, EngineSwitchRequestSchema, EngineOffRequestSchema } from "../schemas.js";
import { attachRunsServiceRun, markExecutionDispatchFailed, reserveCampaignExecution, resolveExecutionConflictPolicy } from "../lib/execution-admission.js";
import { SLUG_RE as ScriptSlugPattern } from "../lib/scripts/script-catalogue.js";
import { engineState, servesChannel, switchEngine, switchEngineOff } from "../lib/scripts/engine.js";
import { ENGINE_EXECUTION_SCOPE, executeEngineRun, planEngineRun, planTaskName, type EngineDispatch, type EngineRunDeps } from "../lib/scripts/engine-runner.js";
import { productionLedgerDeps, runStoredScript } from "../lib/scripts/script-runner.js";
import { productionVendorDeps } from "../lib/scripts/vendors.js";
import { SwitchError } from "../lib/scripts/script-writer-switch.js";
import { noteScriptRunForGuard } from "../lib/scripts/script-guard.js";
import { workflowRuns } from "../db/schema.js";
import { eq } from "drizzle-orm";

const router = Router();

const outcomeOf = (req: Request, res: Response): string | null => {
  const outcome = String(req.params.outcome ?? "");
  if (!ScriptSlugPattern.test(outcome)) {
    res.status(400).json({ error: `${outcome} is not an outcome key` });
    return null;
  }
  return outcome;
};

function formatRow(r: WorkflowRun) {
  return {
    ...r,
    reservedAt: r.reservedAt?.toISOString() ?? null,
    dispatchStartedAt: r.dispatchStartedAt?.toISOString() ?? null,
    startedAt: r.startedAt?.toISOString() ?? null,
    completedAt: r.completedAt?.toISOString() ?? null,
    createdAt: r.createdAt?.toISOString() ?? null,
  };
}

/** campaign-service's pipeline callbacks, with this service's key. */
export function productionCampaignCallbacks(): EngineRunDeps["campaign"] {
  return {
    async call(path, headers, body) {
      const base = (process.env.CAMPAIGN_SERVICE_URL ?? "").replace(/\/$/, "");
      const key = process.env.CAMPAIGN_SERVICE_API_KEY ?? "";
      if (!base || !key) throw new Error("CAMPAIGN_SERVICE_URL and CAMPAIGN_SERVICE_API_KEY must be set to run an Engine");
      const res = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json", "x-api-key": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(300_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`campaign-service POST ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    },
  };
}

export function productionEngineRunDeps(): EngineRunDeps {
  const ledger = productionLedgerDeps();
  return {
    ledger,
    campaign: productionCampaignCallbacks(),
    runScript: (input, who, owned) => runStoredScript(db, { ...input, billing: "org" }, who, { ledger, vendors: productionVendorDeps() }, owned),
    noteScriptRun: (outcome) => void noteScriptRunForGuard(outcome),
  };
}

let depsFactory: () => EngineRunDeps = productionEngineRunDeps;
/** Tests swap the outside world. */
export function setEngineRunDepsFactory(f: (() => EngineRunDeps) | null): void {
  depsFactory = f ?? productionEngineRunDeps;
}

router.get("/internal/engines/:outcome", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const orgId = typeof req.query.orgId === "string" && req.query.orgId ? req.query.orgId : null;
  const featureSlug = typeof req.query.featureSlug === "string" && req.query.featureSlug ? req.query.featureSlug : null;
  try {
    const state = await engineState(db, outcome, orgId);
    // Asked for one campaign's channel: live only when a script of the Engine serves it (servesChannel).
    if (state.live && featureSlug && !(await servesChannel(db, outcome, featureSlug))) {
      res.json({ ...state, live: false, servesChannel: false });
      return;
    }
    res.json(state);
  } catch (err) {
    console.error("[workflow-service] engine state:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/internal/engines/:outcome/switch", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const parsed = EngineSwitchRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const row = await switchEngine(db, { outcome, dynasty: parsed.data.dynasty, orgId: parsed.data.orgId ?? null });
    console.log(`[workflow-service] engine ${outcome} live for campaigns of ${row.orgId ?? "every org"} (proven on ${row.dynasty}/v${row.scriptVersion})`);
    res.status(201).json(await engineState(db, outcome, row.orgId));
  } catch (err) {
    if (err instanceof SwitchError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[workflow-service] engine switch:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/internal/engines/:outcome/off", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const parsed = EngineOffRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const rows = await switchEngineOff(db, { outcome, orgId: parsed.data.orgId ?? null, reason: parsed.data.reason });
    console.log(`[workflow-service] engine ${outcome} off for campaigns of ${parsed.data.orgId ?? "every org"}: ${parsed.data.reason}`);
    res.json({ switchedOff: rows.length, state: await engineState(db, outcome, parsed.data.orgId ?? null) });
  } catch (err) {
    console.error("[workflow-service] engine off:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

const header = (req: Request, k: string) => (typeof req.headers[k] === "string" ? (req.headers[k] as string).trim() : "");

router.post("/engines/:outcome/execute", requireApiKey, executeRateLimit, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const missing = ["x-org-id", "x-user-id", "x-run-id", "x-brand-id", "x-campaign-id"].filter((h) => !header(req, h));
  if (missing.length > 0) {
    res.status(400).json({ error: `Missing required headers for an Engine run: ${missing.join(", ")}` });
    return;
  }
  const parsed = EngineExecuteRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  const body = parsed.data;
  const inputs = body.inputs ?? {};
  const audienceHeader = header(req, "x-audience-id");
  const d: EngineDispatch = {
    outcome,
    fromOutcome: body.fromOutcome,
    orgId: header(req, "x-org-id"),
    userId: header(req, "x-user-id"),
    callerRunId: header(req, "x-run-id"),
    campaignId: header(req, "x-campaign-id"),
    brandIdHeader: header(req, "x-brand-id"),
    featureSlug: header(req, "x-feature-slug") || null,
    audienceId: (typeof inputs.audienceId === "string" && inputs.audienceId) || audienceHeader || null,
    inputs,
  };
  try {
    const state = await engineState(db, outcome, d.orgId);
    if (!state.live) {
      res.status(409).json({ code: "engine_not_live", error: `the ${outcome} Engine does not run this org's campaigns: dispatch its workflow`, state });
      return;
    }
    if (!(await servesChannel(db, outcome, d.featureSlug))) {
      res.status(409).json({ code: "engine_not_live", error: `no script of the ${outcome} Engine serves this campaign yet: dispatch its workflow`, state: { ...state, live: false } });
      return;
    }
    const conflictPolicy = resolveExecutionConflictPolicy(body.conflictPolicy);
    const reservation = await reserveCampaignExecution({
      database: db,
      workflow: null,
      orgId: d.orgId,
      userId: d.userId,
      campaignId: d.campaignId,
      brandIds: d.brandIdHeader.split(",").map((s) => s.trim()).filter(Boolean),
      featureSlug: d.featureSlug ?? "",
      inputs: { ...inputs, engineOutcome: outcome, fromOutcome: d.fromOutcome },
      attributionContext: null,
      conflictPolicy,
      executionSubject: body.executionSubject,
      executionScope: ENGINE_EXECUTION_SCOPE,
    });
    if (reservation.kind === "conflict") {
      if (conflictPolicy === "reject") {
        res.status(409).json({ error: "Active execution already exists for this campaign" + (body.executionSubject === undefined ? "" : " and subject"), workflowRun: formatRow(reservation.run) });
        return;
      }
      res.status(200).json(formatRow(reservation.run));
      return;
    }
    const plan = await planEngineRun(db, d);
    const deps = depsFactory();
    let runId: string;
    try {
      runId = await deps.ledger.createRun({
        parentRunId: d.callerRunId,
        orgId: d.orgId,
        userId: d.userId,
        taskName: planTaskName(d, plan),
        headers: {
          "x-campaign-id": d.campaignId,
          "x-brand-id": d.brandIdHeader,
          ...(d.featureSlug ? { "x-feature-slug": d.featureSlug } : {}),
          ...(d.audienceId ? { "x-audience-id": d.audienceId } : {}),
        },
      });
    } catch (err) {
      await markExecutionDispatchFailed(db, reservation.run.id, err instanceof Error ? err.message : String(err), false);
      throw err;
    }
    await attachRunsServiceRun(db, reservation.run.id, runId);
    const [row] = await db.update(workflowRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowRuns.id, reservation.run.id)).returning();
    console.log(
      `[workflow-service] engine ${outcome} run=${runId} campaign=${d.campaignId} from=${d.fromOutcome}: ` +
        (plan.kind === "none" ? "no script it can run" : `${plan.kind} ${plan.script.outcome}/${plan.script.dynasty}/v${plan.script.version}`),
    );
    res.status(201).json(formatRow(row!));
    void executeEngineRun(db, reservation.run.id, runId, d, plan, deps);
  } catch (err) {
    console.error("[workflow-service] engine execute:", err);
    if (!res.headersSent) res.status(502).json({ error: `Could not start the ${outcome} Engine run: ${err instanceof Error ? err.message : String(err)}` });
  }
});

export default router;
