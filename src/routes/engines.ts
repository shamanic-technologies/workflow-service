/**
 * MIGRATE-1105 S0: the door a campaign run takes to its ENGINE (stored scripts), with no workflow.
 *
 *   GET  /internal/engines/{outcome}?orgId=     is this Engine live for this org's campaigns (campaign-service reads it)
 *   POST /engines/{outcome}/execute             run it for one campaign dispatch (same identity/admission as a workflow)
 *   POST /internal/engines/{outcome}/switch     switch it on for one org, or every org (staff / the migration steps)
 *   POST /internal/engines/{outcome}/off        switch it off for one org, or every org
 *   POST /internal/engines/{outcome}/pick       the Rating's pick among kept dynasties, outside a run (a preview)
 *   POST /internal/engines/{outcome}/make       the Rating's pick, RUN for a service waiting on its Unit (a field draft)
 *   GET  /internal/engines                      every Engine of the live catalogue: callable now or why not (Distry, dashboard)
 *   POST /internal/engines/{outcome}/calls      one Unit for a caller that is not a campaign (Distry): pick, run, wait or poll
 *   GET  /internal/engine-calls/{callId}        that call read back (waits up to `waitSeconds` for it to end)
 *
 * Mounted before the identity gate: the execute route checks its own headers (and never needs `x-workflow-slug`).
 */
import { Router, type Request, type Response } from "express";
import { db } from "../db/index.js";
import { engineReasons, type WorkflowRun } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { executeRateLimit } from "../middleware/rate-limit.js";
import { zodErrorDetails } from "../lib/zod-error-details.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { EngineExecuteRequestSchema, EngineSwitchRequestSchema, EngineOffRequestSchema, EnginePickRequestSchema, EngineMakeRequestSchema, EngineCallRequestSchema, EngineReasonRequestSchema, ENGINE_CALL_DEFAULT_WAIT_SECONDS, ENGINE_CALL_MAX_WAIT_SECONDS } from "../schemas.js";
import { callEnded, listEngines, readEngineCall, servedCall, startEngineCall, type EngineCallDeps } from "../lib/scripts/engine-calls.js";
import { attachRunsServiceRun, markExecutionDispatchFailed, reserveCampaignExecution, resolveExecutionConflictPolicy } from "../lib/execution-admission.js";
import { SLUG_RE as ScriptSlugPattern } from "../lib/scripts/script-catalogue.js";
import { engineState, pickScript, servesChannel, switchEngine, switchEngineOff } from "../lib/scripts/engine.js";
import { ENGINE_EXECUTION_SCOPE, executeEngineRun, planEngineRun, planScriptSlug, planTaskName, type EngineDispatch, type EngineRunDeps } from "../lib/scripts/engine-runner.js";
import { productionLedgerDeps, runStoredScript, ScriptRunFailed } from "../lib/scripts/script-runner.js";
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

// PREVIEW-RATING-PICK-1111: the Rating's pick with no campaign and no run (content-generation's email preview). The SAME
// `pickScript` a run calls, among the dynasties the caller's strategy keeps: reads only, nothing spent or written.
router.post("/internal/engines/:outcome/pick", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const parsed = EnginePickRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const pick = await pickScript(db, {
      outcome,
      servable: parsed.data.servable,
      channel: parsed.data.channel ?? null,
      keptDynasties: parsed.data.keptDynasties,
      orgId: header(req, "x-org-id") || null,
      ...(parsed.data.askedBy ? { askedBy: parsed.data.askedBy, handed: parsed.data.servable } : {}),
    });
    if (!pick) {
      res.status(404).json({
        code: "no_runnable_script",
        error: `no script of Engine ${outcome} among ${parsed.data.keptDynasties.join(", ")} can run on ${parsed.data.servable.length ? parsed.data.servable.join(", ") : "no Units"}${parsed.data.channel ? ` for channel ${parsed.data.channel}` : ""}`,
      });
      return;
    }
    res.json(servedPick(outcome, pick));
  } catch (err) {
    // The Rating (features-service) or the strategy could not answer: pick nothing, the caller retries.
    console.error("[workflow-service] engine pick:", err);
    res.status(502).json({ code: "script_pick_unreadable", error: err instanceof Error ? err.message : String(err) });
  }
});

/** A pick as the pick and make routes serve it: the picked version's own tactics included (what it writes with). */
function servedPick(outcome: string, pick: NonNullable<Awaited<ReturnType<typeof pickScript>>>) {
  return {
    outcome,
    dynasty: pick.script.dynasty,
    version: pick.script.version,
    scriptId: pick.script.id,
    tactics: (pick.script.tactics ?? {}) as Record<string, unknown>,
    basis: pick.basis,
    draws: pick.draws,
  };
}

// SCRIPT-VALUE-RATING-1113-WF3: a service whose client waits on a Unit (brand-service's field drafts) asks the Engine
// for it instead of calling an LLM it picked itself: the SAME `pickScript` a run calls, then the picked script runs on
// its own run, a child of the caller's, exactly as `/internal/scripts/run` runs it. One pick, one script, no fall-through
// (the client is waiting), never a default script.
router.post("/internal/engines/:outcome/make", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const orgId = header(req, "x-org-id");
  const parentRunId = header(req, "x-run-id");
  if (!parentRunId) {
    res.status(400).json({ error: "x-run-id (the caller's own run) is required" });
    return;
  }
  const parsed = EngineMakeRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  const body = parsed.data;
  const servable = Object.keys(body.units);
  let pick;
  try {
    pick = await pickScript(db, { outcome, servable, channel: body.channel ?? null, keptDynasties: body.keptDynasties, orgId });
  } catch (err) {
    console.error(`[workflow-service] engine make ${outcome}: pick unreadable:`, err);
    res.status(502).json({ code: "script_pick_unreadable", error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (!pick) {
    res.status(404).json({
      code: "no_runnable_script",
      error: `no script of Engine ${outcome}${body.keptDynasties ? ` among ${body.keptDynasties.join(", ")}` : ""} can run on ${servable.length ? servable.join(", ") : "no Units"}${body.channel ? ` for channel ${body.channel}` : ""}`,
    });
    return;
  }
  const served = servedPick(outcome, pick);
  const started = Date.now();
  try {
    const result = await runStoredScript(
      db,
      {
        outcome,
        dynasty: pick.script.dynasty,
        version: pick.script.version,
        units: body.units,
        ...(body.request !== undefined ? { request: body.request } : {}),
        ...(body.subject ? { subject: body.subject } : {}),
        ...(body.recordedBy ? { recordedBy: body.recordedBy } : {}),
        ...(body.trace ? { trace: true } : {}),
        billing: orgId && body.billing === "org" ? "org" : "platform",
      },
      { orgId, userId: header(req, "x-user-id"), parentRunId, headers: extractDownstreamHeaders(req) },
      { ledger: productionLedgerDeps(), vendors: productionVendorDeps() },
    );
    console.log(
      `[workflow-service] engine make ${result.scriptSlug} run=${result.runId} parent=${parentRunId} status=${result.status} ms=${Date.now() - started} ` +
        `vendors=${result.vendorCalls.map((c) => `${c.name}:${c.ok ? "ok" : "refused"}`).join(",") || "none"}`,
    );
    res.json({ ...result, pick: served });
    noteScriptRunForGuard(outcome);
  } catch (err) {
    if (err instanceof ScriptRunFailed) {
      noteScriptRunForGuard(outcome);
      console.error(`[workflow-service] engine make ${err.result.scriptSlug} run=${err.result.runId} ${err.result.status}: ${err.result.error}`);
      res.status(502).json({ error: `script ${err.result.scriptSlug} ${err.result.status}: ${err.result.error}`, details: { ...err.result, pick: served } });
      return;
    }
    console.error(`[workflow-service] engine make ${outcome}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// DISTRY-PRINCIPAL-1119: every Engine of the live catalogue, callable now or why not, and what a caller hands each one.
router.get("/internal/engines", requireApiKey, async (_req, res) => {
  try {
    const engines = await listEngines(db);
    res.json({ engines, callable: engines.filter((e) => e.callable).length, total: engines.length });
  } catch (err) {
    console.error("[workflow-service] engine list:", err);
    res.status(502).json({ code: "engine_list_unreadable", error: err instanceof Error ? err.message : String(err) });
  }
});

// DISTRY-ENGINES-1119: why an Engine no script makes on demand is not callable, stated by staff as data (never a branch
// on an outcome in code); the Engine list shows it as-is while no script of the Engine can run.
router.put("/internal/engines/:outcome/reason", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const parsed = EngineReasonRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  const email = req.header("x-email");
  const user = req.header("x-user-id");
  const statedBy = parsed.data.statedBy ?? (email ? email : user ? `user:${user}` : null);
  if (!statedBy) {
    res.status(400).json({ error: "statedBy is required when the call carries no x-email or x-user-id" });
    return;
  }
  try {
    const now = new Date();
    const [row] = await db
      .insert(engineReasons)
      .values({ outcome, reason: parsed.data.reason, statedBy, statedAt: now })
      .onConflictDoUpdate({ target: engineReasons.outcome, set: { reason: parsed.data.reason, statedBy, statedAt: now } })
      .returning();
    console.log(`[workflow-service] engine ${outcome}: reason stated by ${statedBy}`);
    res.json({ outcome: row!.outcome, reason: row!.reason, statedBy: row!.statedBy, statedAt: row!.statedAt.toISOString() });
  } catch (err) {
    console.error(`[workflow-service] engine reason ${outcome}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

router.delete("/internal/engines/:outcome/reason", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  try {
    const gone = await db.delete(engineReasons).where(eq(engineReasons.outcome, outcome)).returning();
    if (!gone.length) {
      res.status(404).json({ code: "reason_not_found", error: `no reason is stated for Engine ${outcome}` });
      return;
    }
    res.status(204).end();
  } catch (err) {
    console.error(`[workflow-service] engine reason ${outcome}:`, err);
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

export function productionEngineCallDeps(): EngineCallDeps {
  const ledger = productionLedgerDeps();
  return {
    run: (input, who) => runStoredScript(db, input, who, { ledger, vendors: productionVendorDeps() }),
    noteScriptRun: (outcome) => noteScriptRunForGuard(outcome),
  };
}

let callDepsFactory: () => EngineCallDeps = productionEngineCallDeps;
/** Tests swap the outside world. */
export function setEngineCallDepsFactory(f: (() => EngineCallDeps) | null): void {
  callDepsFactory = f ?? productionEngineCallDeps;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** Resolves with the value, or null once `ms` elapsed first. */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => null)]);

// DISTRY-PRINCIPAL-1119: one Unit of an Engine for a caller that is not a campaign (Distry). The SAME Rating pick a
// campaign run takes, the picked script run on its own run (a child of the caller's), org-billed; the call answers once
// ended or after `waitSeconds` (202, then GET /internal/engine-calls/{callId}), so no client times out on a long Engine.
router.post("/internal/engines/:outcome/calls", requireApiKey, async (req, res) => {
  const outcome = outcomeOf(req, res);
  if (!outcome) return;
  const orgId = header(req, "x-org-id");
  const callerRunId = header(req, "x-run-id");
  if (!orgId || !callerRunId) {
    res.status(400).json({ error: "x-org-id (the org the Unit is for, billed) and x-run-id (the caller's own run) are required" });
    return;
  }
  const parsed = EngineCallRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  const body = parsed.data;
  let started;
  try {
    started = await startEngineCall(
      db,
      {
        outcome,
        orgId,
        userId: header(req, "x-user-id"),
        callerRunId,
        headers: extractDownstreamHeaders(req) as Record<string, string>,
        units: body.units ?? {},
        request: body.request ?? null,
        ...(body.subject ? { subject: body.subject } : {}),
        channel: body.channel ?? null,
      },
      callDepsFactory(),
    );
  } catch (err) {
    console.error(`[workflow-service] engine call ${outcome}: pick unreadable:`, err);
    res.status(502).json({ code: "script_pick_unreadable", error: err instanceof Error ? err.message : String(err) });
    return;
  }
  if (started.kind === "not_callable") {
    res.status(404).json({ code: "no_runnable_script", error: started.message });
    return;
  }
  const ended = await within(started.done, (body.waitSeconds ?? ENGINE_CALL_DEFAULT_WAIT_SECONDS) * 1000);
  if (ended) {
    res.json(servedCall(ended));
    return;
  }
  res.status(202).json(servedCall(started.call));
});

router.get("/internal/engine-calls/:callId", requireApiKey, async (req, res) => {
  const orgId = header(req, "x-org-id");
  if (!orgId) {
    res.status(400).json({ error: "x-org-id (the org the call was made for) is required" });
    return;
  }
  const raw = typeof req.query.waitSeconds === "string" ? Number(req.query.waitSeconds) : 0;
  if (!Number.isInteger(raw) || raw < 0 || raw > ENGINE_CALL_MAX_WAIT_SECONDS) {
    res.status(400).json({ error: `waitSeconds must be a whole number from 0 to ${ENGINE_CALL_MAX_WAIT_SECONDS}` });
    return;
  }
  const callId = String(req.params.callId ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(callId)) {
    res.status(400).json({ error: `${callId} is not a call id` });
    return;
  }
  try {
    const deadline = Date.now() + raw * 1000;
    let row = await readEngineCall(db, callId, orgId);
    while (row && !callEnded(row) && Date.now() < deadline) {
      await sleep(Math.min(1000, Math.max(0, deadline - Date.now())));
      row = await readEngineCall(db, callId, orgId);
    }
    if (!row) {
      res.status(404).json({ code: "call_not_found", error: `no Engine call ${callId} for this org` });
      return;
    }
    res.json(servedCall(row));
  } catch (err) {
    console.error("[workflow-service] engine call read:", err);
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
    if (!(await servesChannel(db, outcome, d.featureSlug, d.campaignId))) {
      res.status(409).json({ code: "engine_not_live", error: `no script of the ${outcome} Engine serves this campaign yet (its channel or its strategy keeps none): dispatch its workflow`, state: { ...state, live: false } });
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
        ...(planScriptSlug(plan) ? { scriptSlug: planScriptSlug(plan) } : {}),
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
