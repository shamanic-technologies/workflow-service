import { Router, type Response } from "express";
import { db } from "../db/index.js";
import { scripts } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireApiKey } from "../middleware/auth.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { zodErrorDetails } from "../lib/zod-error-details.js";
import {
  CreateScriptRequestSchema,
  ForkScriptRequestSchema,
  PutScriptCasesRequestSchema,
  ReplayScriptRequestSchema,
  RunScriptRequestSchema,
  ScriptDynastyStatusRequestSchema,
  UpgradeScriptRequestSchema,
} from "../schemas.js";
import {
  ScriptCatalogueError,
  activeVersion,
  caseCount,
  createScript,
  dynastyVersions,
  forkScript,
  listScripts,
  productionCatalogueDeps,
  proveOnCases,
  putCases,
  reproveActive,
  serveScript,
  setDynastyStatus,
  summarizeScript,
  upgradeScript,
  type Author,
} from "../lib/scripts/script-catalogue.js";
import { ScriptRunFailed, productionLedgerDeps, runStoredScript } from "../lib/scripts/script-runner.js";
import { productionVendorDeps } from "../lib/scripts/vendors.js";
import type { ReplayCase } from "../lib/scripts/replay.js";

/**
 * FACTORY-P2-ENGINES: scripts as data (src/lib/scripts/*). Identity-gated (mounted after `requireIdentity`), except
 * the cases loader, which is service-key only and lives on `internalScriptsRouter` (mounted before the gate).
 */
const router = Router();
export const internalScriptsRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function author(res: Response, req: { headers: Record<string, string | string[] | undefined> }): Author {
  const email = typeof req.headers["x-email"] === "string" ? req.headers["x-email"].trim() : "";
  return { orgId: String(res.locals.orgId), createdBy: email || `user:${String(res.locals.userId)}` };
}

function fail(res: Response, err: unknown, what: string): void {
  if (err instanceof ScriptCatalogueError) {
    res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[workflow-service] scripts: ${what} failed: ${message}`);
  res.status(502).json({ error: `${what} failed: ${message}` });
}

async function served(rows: Awaited<ReturnType<typeof dynastyVersions>>) {
  const counts = new Map<string, number>();
  const out = [];
  for (const r of rows) {
    const k = `${r.outcome}/${r.dynasty}`;
    if (!counts.has(k)) counts.set(k, await caseCount(db, r.outcome, r.dynasty));
    out.push(summarizeScript(r, counts.get(k)!));
  }
  return out;
}

router.get("/scripts", requireApiKey, async (req, res) => {
  const status = req.query.status === undefined ? "active" : String(req.query.status);
  if (!["active", "deprecated", "all"].includes(status)) {
    res.status(400).json({ error: "status must be active, deprecated or all" });
    return;
  }
  try {
    const rows = await listScripts(db, {
      outcome: typeof req.query.outcome === "string" ? req.query.outcome : undefined,
      dynasty: typeof req.query.dynasty === "string" ? req.query.dynasty : undefined,
      status: status as "active" | "deprecated" | "all",
    });
    res.json({ scripts: await served(rows) });
  } catch (err) {
    fail(res, err, "list scripts");
  }
});

router.get("/scripts/dynasty/:outcome/:dynasty", requireApiKey, async (req, res) => {
  try {
    const versions = await dynastyVersions(db, req.params.outcome, req.params.dynasty);
    if (versions.length === 0) {
      res.status(404).json({ error: `no script ${req.params.outcome}/${req.params.dynasty}` });
      return;
    }
    res.json({ outcome: req.params.outcome, dynasty: req.params.dynasty, cases: await caseCount(db, req.params.outcome, req.params.dynasty), versions: await served(versions) });
  } catch (err) {
    fail(res, err, "read script dynasty");
  }
});

router.get("/scripts/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid script id: expected a UUID" });
    return;
  }
  try {
    const [row] = await db.select().from(scripts).where(eq(scripts.id, req.params.id));
    if (!row) {
      res.status(404).json({ error: "Script not found" });
      return;
    }
    res.json(serveScript(row, await caseCount(db, row.outcome, row.dynasty)));
  } catch (err) {
    fail(res, err, "read script");
  }
});

router.post("/scripts", requireApiKey, async (req, res) => {
  const parsed = CreateScriptRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const row = await createScript(db, parsed.data, author(res, req), productionCatalogueDeps());
    console.log(`[workflow-service] script created ${row.outcome}/${row.dynasty}/v${row.version} by ${row.createdBy}`);
    res.status(201).json(serveScript(row, await caseCount(db, row.outcome, row.dynasty)));
  } catch (err) {
    fail(res, err, "create script");
  }
});

router.post("/scripts/dynasty/:outcome/:dynasty/upgrade", requireApiKey, async (req, res) => {
  const parsed = UpgradeScriptRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const row = await upgradeScript(db, req.params.outcome, req.params.dynasty, parsed.data, author(res, req));
    console.log(`[workflow-service] script upgraded ${row.outcome}/${row.dynasty}/v${row.version} by ${row.createdBy} replay=${JSON.stringify(row.replay)}`);
    res.status(201).json(serveScript(row, await caseCount(db, row.outcome, row.dynasty)));
  } catch (err) {
    fail(res, err, "upgrade script");
  }
});

router.post("/scripts/dynasty/:outcome/:dynasty/fork", requireApiKey, async (req, res) => {
  const parsed = ForkScriptRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const row = await forkScript(db, req.params.outcome, req.params.dynasty, parsed.data, author(res, req));
    console.log(`[workflow-service] script forked ${req.params.outcome}/${req.params.dynasty} -> ${row.outcome}/${row.dynasty}/v1 by ${row.createdBy}`);
    res.status(201).json(serveScript(row, await caseCount(db, row.outcome, row.dynasty)));
  } catch (err) {
    fail(res, err, "fork script");
  }
});

router.put("/scripts/dynasty/:outcome/:dynasty/status", requireApiKey, async (req, res) => {
  const parsed = ScriptDynastyStatusRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const versions = await setDynastyStatus(db, req.params.outcome, req.params.dynasty, parsed.data.status, parsed.data.reason);
    console.log(`[workflow-service] script dynasty ${req.params.outcome}/${req.params.dynasty} -> ${parsed.data.status} (${parsed.data.reason})`);
    res.json({ versions: await served(versions) });
  } catch (err) {
    fail(res, err, "set script dynasty status");
  }
});

router.post("/scripts/dynasty/:outcome/:dynasty/replay", requireApiKey, async (req, res) => {
  const parsed = ReplayScriptRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const { outcome, dynasty } = req.params;
    const code = parsed.data.code ?? (await activeVersion(db, outcome, dynasty))?.code;
    if (!code) {
      res.status(404).json({ error: `no active version of ${outcome}/${dynasty}, and no code given` });
      return;
    }
    const summary = await proveOnCases(db, outcome, dynasty, code);
    if (!summary) {
      res.status(404).json({ error: `${outcome}/${dynasty} carries no recorded case` });
      return;
    }
    res.json({
      cases: summary.cases,
      matches: summary.matches,
      failures: summary.failures.slice(0, 5).map((f) => ({ id: f.id, diffs: f.diffs.slice(0, 3).map((d) => d.slice(0, 300)) })),
    });
  } catch (err) {
    fail(res, err, "replay script");
  }
});

router.post("/orgs/scripts/run", requireApiKey, async (req, res) => {
  const parsed = RunScriptRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const result = await runStoredScript(
      db,
      parsed.data,
      { orgId: String(res.locals.orgId), userId: String(res.locals.userId), parentRunId: String(res.locals.runId), headers: extractDownstreamHeaders(req) },
      { ledger: productionLedgerDeps(), vendors: productionVendorDeps() },
    );
    console.log(
      `[workflow-service] script run ${result.scriptSlug} run=${result.runId} parent=${String(res.locals.runId)} status=${result.status} ` +
        `vendors=${result.vendorCalls.map((c) => `${c.name}:${c.ok ? "ok" : "refused"}`).join(",") || "none"} ` +
        `produced=${result.declared.produced.length} consumed=${result.declared.consumed.length}`,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof ScriptRunFailed) {
      console.error(`[workflow-service] script run ${err.result.scriptSlug} run=${err.result.runId} ${err.result.status}: ${err.result.error}`);
      res.status(502).json({ error: `script ${err.result.scriptSlug} ${err.result.status}: ${err.result.error}`, details: err.result });
      return;
    }
    fail(res, err, "run script");
  }
});

internalScriptsRouter.put("/internal/scripts/dynasty/:outcome/:dynasty/cases", requireApiKey, async (req, res) => {
  const parsed = PutScriptCasesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: zodErrorDetails(parsed.error) });
    return;
  }
  try {
    const out = await putCases(db, req.params.outcome, req.params.dynasty, parsed.data.cases as unknown as ReplayCase[], parsed.data.source);
    const reproved = req.query.reprove === "true" ? await reproveActive(db, req.params.outcome, req.params.dynasty) : null;
    console.log(`[workflow-service] script cases ${req.params.outcome}/${req.params.dynasty}: stored ${out.stored}, total ${out.total}, reproved ${JSON.stringify(reproved)}`);
    res.json({ ...out, reproved });
  } catch (err) {
    fail(res, err, "store script cases");
  }
});

export default router;
