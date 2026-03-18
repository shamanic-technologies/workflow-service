import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { validateDAG, type DAG } from "../lib/dag-validator.js";
import { dagToOpenFlow } from "../lib/dag-to-openflow.js";
import { getWindmillClient } from "../lib/windmill-client.js";
import {
  CreateWorkflowSchema,
  UpdateWorkflowSchema,
  DeployWorkflowsSchema,
  GenerateWorkflowSchema,
  RankedWorkflowQuerySchema,
  BestWorkflowQuerySchema,
} from "../schemas.js";
import {
  generateWorkflow,
  GenerationValidationError,
} from "../lib/workflow-generator.js";
import { computeDAGSignature } from "../lib/dag-signature.js";
import { pickSignatureName } from "../lib/signature-words.js";
import { extractHttpEndpoints } from "../lib/extract-http-endpoints.js";
import { validateWorkflowEndpoints } from "../lib/validate-workflow-endpoints.js";
import { fetchSpecsForServices } from "../lib/api-registry-client.js";
import { fetchProviderRequirements, fetchAnthropicKey } from "../lib/key-service-client.js";
import { enrichProvidersWithDomains } from "../lib/provider-domains.js";
import { extractTemplateRefs, validateTemplateContracts, type TemplateContractIssue, type TemplateRef } from "../lib/validate-template-contracts.js";
import { fetchPromptTemplates } from "../lib/content-generation-client.js";
import {
  getUpgradeChainIds,
  computeWorkflowScores,
  rankScores,
  formatScoreItem,
  aggregateSectionStats,
  handleExternalServiceError,
  type WorkflowScore,
} from "../lib/workflow-scoring.js";

const router = Router();

function formatWorkflow(w: typeof workflows.$inferSelect) {
  return {
    ...w,
    createdAt: w.createdAt?.toISOString() ?? null,
    updatedAt: w.updatedAt?.toISOString() ?? null,
  };
}

function generateFlowPath(scope: string, name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `f/workflows/${scope}/${slug}`;
}

// POST /workflows/generate — Generate a workflow from natural language
router.post("/workflows/generate", requireApiKey, async (req, res) => {
  try {
    const body = GenerateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const userId = res.locals.userId as string;
    const runId = res.locals.runId as string;
    const identity = { orgId, userId, runId };

    const { key: anthropicApiKey } = await fetchAnthropicKey({ orgId, userId, runId });

    const generated = await generateWorkflow(
      { description: body.description, hints: body.hints, style: body.style },
      anthropicApiKey,
      identity,
    );

    const dag = generated.dag as DAG;
    const signature = computeDAGSignature(generated.dag);

    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));

    const [existing] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, orgId),
          eq(workflows.signature, signature),
          eq(workflows.status, "active"),
        )
      );

    type DeployResult = {
      id: string;
      name: string;
      category: string;
      channel: string;
      audienceType: string;
      tags: string[];
      signature: string;
      signatureName: string;
      action: "created" | "updated";
    };

    let result: DeployResult;

    if (existing) {
      const openFlow = dagToOpenFlow(dag, existing.name);
      const client = getWindmillClient();
      if (client && existing.windmillFlowPath) {
        try {
          await client.updateFlow(existing.windmillFlowPath, {
            summary: existing.name,
            description: generated.description,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (err) {
          console.error("[workflow-service] generate: failed to update Windmill flow:", err);
        }
      }

      const [updated] = await db
        .update(workflows)
        .set({
          description: generated.description,
          category: generated.category,
          channel: generated.channel,
          audienceType: generated.audienceType,
          dag: generated.dag,
          updatedAt: new Date(),
        })
        .where(eq(workflows.id, existing.id))
        .returning();

      result = {
        id: updated.id,
        name: updated.name,
        category: updated.category,
        channel: updated.channel,
        audienceType: updated.audienceType,
        tags: (updated.tags as string[]) ?? [],
        signature: updated.signature,
        signatureName: updated.signatureName,
        action: "updated",
      };
    } else {
      let signatureName: string;
      let displayName: string;
      let styleName: string | null = null;
      let humanId: string | null = null;
      let brandId: string | null = null;

      if (body.style) {
        styleName = body.style.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");

        // Count existing workflows with same (orgId, styleName) for versioning
        const sameStyle = await db
          .select({ id: workflows.id })
          .from(workflows)
          .where(
            and(
              eq(workflows.orgId, orgId),
              eq(workflows.styleName, styleName),
            )
          );
        const version = sameStyle.length + 1;

        signatureName = `${styleName}-v${version}`;
        displayName = `${body.style.name} v${version}`;

        if (body.style.type === "human" && body.style.humanId) {
          humanId = body.style.humanId;
        }
        if (body.style.type === "brand" && body.style.brandId) {
          brandId = body.style.brandId;
        }
      } else {
        signatureName = pickSignatureName(signature, usedNames);
        displayName = `${generated.category}-${generated.channel}-${generated.audienceType}-${signatureName}`;
      }

      const name = `${generated.category}-${generated.channel}-${generated.audienceType}-${signatureName}`;
      const openFlow = dagToOpenFlow(dag, name);
      const flowPath = generateFlowPath(orgId, name);
      const client = getWindmillClient();

      if (client) {
        try {
          await client.createFlow({
            path: flowPath,
            summary: name,
            description: generated.description,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (err) {
          console.error("[workflow-service] generate: failed to create Windmill flow:", err);
        }
      }

      const [created] = await db
        .insert(workflows)
        .values({
          orgId,
          name,
          displayName,
          description: generated.description,
          category: generated.category,
          channel: generated.channel,
          audienceType: generated.audienceType,
          signature,
          signatureName,
          dag: generated.dag,
          windmillFlowPath: flowPath,
          humanId,
          brandId,
          styleName,
          createdByUserId: userId,
          createdByRunId: runId,
        })
        .returning();

      result = {
        id: created.id,
        name: created.name,
        category: created.category,
        channel: created.channel,
        audienceType: created.audienceType,
        tags: (created.tags as string[]) ?? [],
        signature: created.signature,
        signatureName: created.signatureName,
        action: "created",
      };
    }

    res.json({
      workflow: result,
      dag: generated.dag,
      category: generated.category,
      channel: generated.channel,
      audienceType: generated.audienceType,
      generatedDescription: generated.description,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    if (err instanceof GenerationValidationError) {
      res.status(422).json({
        error: err.message,
        details: err.validationErrors,
      });
      return;
    }
    if (err instanceof Error && err.message.startsWith("key-service error:")) {
      console.error("[workflow-service] generate: key-service error:", err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("KEY_SERVICE_URL")) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[workflow-service] GENERATE error:", err);
    res.status(500).json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
  }
});

// POST /workflows — Create a new workflow
router.post("/workflows", requireApiKey, async (req, res) => {
  try {
    const body = CreateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;
    const dag = body.dag as DAG;

    // Validate the DAG
    const validation = validateDAG(dag);
    if (!validation.valid) {
      res.status(400).json({ error: "Invalid DAG", details: validation.errors });
      return;
    }

    // Translate to OpenFlow
    const openFlow = dagToOpenFlow(dag, body.name);
    const flowPath = generateFlowPath(orgId, body.name);

    // Push to Windmill (if configured)
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: body.name,
          description: body.description,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflow-service] Failed to create flow in Windmill:", err);
      }
    }

    // Compute signature
    const signature = computeDAGSignature(body.dag);
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));
    const signatureName = pickSignatureName(signature, usedNames);

    // Store in DB
    const [workflow] = await db
      .insert(workflows)
      .values({
        orgId,
        brandId: body.brandId,
        campaignId: body.campaignId,
        subrequestId: body.subrequestId,
        name: body.name,
        description: body.description,
        category: body.category,
        channel: body.channel,
        audienceType: body.audienceType,
        tags: body.tags ?? [],
        signature,
        signatureName,
        dag: body.dag,
        windmillFlowPath: flowPath,
        createdByUserId: res.locals.userId as string,
        createdByRunId: res.locals.runId as string,
      })
      .returning();

    res.status(201).json(formatWorkflow(workflow));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] POST error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/deploy — Batch upsert workflows by (orgId + signature)
router.put("/workflows/deploy", requireApiKey, async (req, res) => {
  try {
    const body = DeployWorkflowsSchema.parse(req.body);
    const orgId = res.locals.orgId as string;

    console.log(`[workflow-service] deploy: org=${orgId} workflows=${body.workflows.length}`);

    // Validate ALL DAGs first — reject if any are invalid
    const dagErrors: { index: number; errors: unknown[] }[] = [];
    for (let i = 0; i < body.workflows.length; i++) {
      const validation = validateDAG(body.workflows[i].dag as DAG);
      if (!validation.valid) {
        dagErrors.push({ index: i, errors: validation.errors ?? [] });
      }
    }
    if (dagErrors.length > 0) {
      res.status(400).json({ error: "Invalid DAGs", details: dagErrors });
      return;
    }

    // Validate endpoint fields against API registry (if configured)
    if (process.env.API_REGISTRY_SERVICE_URL && process.env.API_REGISTRY_SERVICE_API_KEY) {
      const allServiceNames = new Set<string>();
      for (const wf of body.workflows) {
        for (const ep of extractHttpEndpoints(wf.dag as DAG)) {
          allServiceNames.add(ep.service);
        }
      }

      if (allServiceNames.size > 0) {
        try {
          const specs = await fetchSpecsForServices([...allServiceNames]);
          const validationErrors: Array<{ index: number; issues: unknown[] }> = [];

          for (let i = 0; i < body.workflows.length; i++) {
            const result = validateWorkflowEndpoints(body.workflows[i].dag as DAG, specs);

            if (result.fieldIssues.length > 0) {
              console.warn(
                `[workflow-service] deploy: workflow[${i}] field issues:`,
                result.fieldIssues.map((f) => `${f.severity}: ${f.reason}`).join("; "),
              );
            }

            const errors = [
              ...result.invalidEndpoints.map((e) => ({
                severity: "error",
                reason: e.reason,
              })),
              ...result.fieldIssues.filter((f) => f.severity === "error"),
            ];

            if (errors.length > 0) {
              validationErrors.push({ index: i, issues: errors });
            }
          }

          if (validationErrors.length > 0) {
            console.error(
              `[workflow-service] deploy: rejected — ${validationErrors.length} workflow(s) with field errors`,
            );
            res.status(400).json({
              error: "Endpoint field validation failed",
              details: validationErrors,
            });
            return;
          }
        } catch (err) {
          console.warn("[workflow-service] deploy: api-registry validation skipped:", err);
          // Don't block deploy if api-registry is unavailable
        }
      }
    }

    // Validate template contracts (variables provided vs declared in prompt templates)
    try {
      const allTemplateRefs: TemplateRef[] = [];
      for (const wf of body.workflows) {
        allTemplateRefs.push(...extractTemplateRefs(wf.dag as DAG));
      }

      if (allTemplateRefs.length > 0) {
        const types = [...new Set(allTemplateRefs.map((r) => r.templateType))];
        const templates = await fetchPromptTemplates(types);

        const templateErrors: Array<{ index: number; issues: TemplateContractIssue[] }> = [];
        for (let i = 0; i < body.workflows.length; i++) {
          const result = validateTemplateContracts(body.workflows[i].dag as DAG, templates);
          const errors = result.issues.filter((issue) => issue.severity === "error");
          if (errors.length > 0) {
            templateErrors.push({ index: i, issues: errors });
          }
        }

        if (templateErrors.length > 0) {
          console.error(
            `[workflow-service] deploy: rejected — ${templateErrors.length} workflow(s) with missing template variables`,
          );
          res.status(400).json({
            error: "Template contract validation failed",
            details: templateErrors,
          });
          return;
        }
      }
    } catch (err) {
      console.warn("[workflow-service] deploy: template contract validation skipped:", err instanceof Error ? err.message : err);
      // Don't block deploy if content-generation is unreachable
    }

    // Fetch all existing signatureNames for this orgId to avoid collisions
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));

    const results: { id: string; name: string; category: string; channel: string; audienceType: string; tags: string[]; signature: string; signatureName: string; action: "created" | "updated" }[] = [];

    for (const wf of body.workflows) {
      const dag = wf.dag as DAG;
      const signature = computeDAGSignature(wf.dag);

      // Check if workflow already exists for this (orgId, signature) — only active
      const [existing] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.orgId, orgId),
            eq(workflows.signature, signature),
            eq(workflows.status, "active"),
          )
        );

      if (existing) {
        // Same DAG already deployed — update metadata
        console.log(
          `[workflow-service] deploy: sig=${signature.slice(0, 12)} matched "${existing.name}" (${existing.id}) -> update`,
        );
        const openFlow = dagToOpenFlow(dag, existing.name);
        const client = getWindmillClient();

        if (client && existing.windmillFlowPath) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: existing.name,
              description: wf.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflow-service] deploy: failed to update Windmill flow:", err);
          }
        }

        const updatedTags = wf.tags ?? (existing.tags as string[]) ?? [];
        const [updated] = await db
          .update(workflows)
          .set({
            orgId,
            description: wf.description ?? existing.description,
            category: wf.category,
            channel: wf.channel,
            audienceType: wf.audienceType,
            tags: updatedTags,
            dag: wf.dag,
            updatedAt: new Date(),
          })
          .where(eq(workflows.id, existing.id))
          .returning();

        results.push({
          id: updated.id,
          name: updated.name,
          category: updated.category,
          channel: updated.channel,
          audienceType: updated.audienceType,
          tags: (updated.tags as string[]) ?? [],
          signature: updated.signature,
          signatureName: updated.signatureName,
          action: "updated",
        });
      } else {
        // New DAG — generate signatureName and build name
        const signatureName = pickSignatureName(signature, usedNames);
        usedNames.add(signatureName);

        const name = `${wf.category}-${wf.channel}-${wf.audienceType}-${signatureName}`;
        console.log(
          `[workflow-service] deploy: sig=${signature.slice(0, 12)} no active match -> create "${name}"`,
        );

        const openFlow = dagToOpenFlow(dag, name);
        const flowPath = generateFlowPath(orgId, name);
        const client = getWindmillClient();

        if (client) {
          try {
            await client.createFlow({
              path: flowPath,
              summary: name,
              description: wf.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflow-service] deploy: failed to create Windmill flow:", err);
          }
        }

        const [created] = await db
          .insert(workflows)
          .values({
            orgId,
            name,
            displayName: name,
            description: wf.description,
            category: wf.category,
            channel: wf.channel,
            audienceType: wf.audienceType,
            tags: wf.tags ?? [],
            signature,
            signatureName,
            dag: wf.dag,
            windmillFlowPath: flowPath,
            createdByUserId: res.locals.userId as string,
            createdByRunId: res.locals.runId as string,
          })
          .returning();

        results.push({
          id: created.id,
          name: created.name,
          category: created.category,
          channel: created.channel,
          audienceType: created.audienceType,
          tags: (created.tags as string[]) ?? [],
          signature: created.signature,
          signatureName: created.signatureName,
          action: "created",
        });
      }
    }

    const createdCount = results.filter((r) => r.action === "created").length;
    const updatedCount = results.filter((r) => r.action === "updated").length;
    console.log(
      `[workflow-service] deploy complete: org=${orgId} total=${results.length} created=${createdCount} updated=${updatedCount}`,
    );

    res.json({ workflows: results });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] PUT deploy error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/ranked — Workflows ranked by cost-per-outcome, with optional groupBy=section
router.get("/workflows/ranked", requireApiKey, async (req, res) => {
  try {
    const query = RankedWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, brandId, category, channel, audienceType, objective, limit, groupBy } = query.data;
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (brandId) conditions.push(eq(workflows.brandId, brandId));
    if (category) conditions.push(eq(workflows.category, category));
    if (channel) conditions.push(eq(workflows.channel, channel));
    if (audienceType) conditions.push(eq(workflows.audienceType, audienceType));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allMatchingWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.status(404).json({ error: "No workflows found matching the criteria" });
      return;
    }

    const scores = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, objective, { kind: "auth", identity });

    if (groupBy === "section") {
      // Group by sectionKey = category-channel-audienceType
      const sectionMap = new Map<string, WorkflowScore[]>();
      for (const score of scores) {
        const key = `${score.workflow.category}-${score.workflow.channel}-${score.workflow.audienceType}`;
        const arr = sectionMap.get(key) ?? [];
        arr.push(score);
        sectionMap.set(key, arr);
      }

      const sections = [...sectionMap.entries()].map(([sectionKey, sectionScores]) => {
        const ranked = rankScores(sectionScores).slice(0, limit);
        const sample = sectionScores[0].workflow;
        return {
          sectionKey,
          category: sample.category,
          channel: sample.channel,
          audienceType: sample.audienceType,
          stats: aggregateSectionStats(sectionScores),
          workflows: ranked.map(formatScoreItem),
        };
      });

      res.json({ sections });
    } else if (groupBy === "brand") {
      // Group by brandId — exclude workflows without a brandId
      const brandMap = new Map<string, WorkflowScore[]>();
      for (const score of scores) {
        if (!score.workflow.brandId) continue;
        const arr = brandMap.get(score.workflow.brandId) ?? [];
        arr.push(score);
        brandMap.set(score.workflow.brandId, arr);
      }

      const brands = [...brandMap.entries()].map(([bId, brandScores]) => ({
        brandId: bId,
        stats: aggregateSectionStats(brandScores),
        workflows: rankScores(brandScores).slice(0, limit).map(formatScoreItem),
      }));

      res.json({ brands });
    } else {
      const ranked = rankScores(scores).slice(0, limit);
      res.json({ results: ranked.map(formatScoreItem) });
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "ranked")) {
      console.error("[workflow-service] GET ranked error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /workflows/best — Hero records: best cost-per-open and best cost-per-reply
router.get("/workflows/best", requireApiKey, async (req, res) => {
  try {
    const query = BestWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, brandId, by } = query.data;
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (brandId) conditions.push(eq(workflows.brandId, brandId));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allMatchingWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.status(404).json({ error: "No active workflows found" });
      return;
    }

    // Use "replies" as objective — we compute both cost-per-open and cost-per-reply from email stats
    const scores = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, "replies", { kind: "auth", identity });

    if (by === "brand") {
      // Aggregate scores by brandId, find the best brand for cost-per-open and cost-per-reply
      const brandMap = new Map<string, WorkflowScore[]>();
      for (const s of scores) {
        if (!s.workflow.brandId) continue;
        const arr = brandMap.get(s.workflow.brandId) ?? [];
        arr.push(s);
        brandMap.set(s.workflow.brandId, arr);
      }

      let bestCostPerOpen: { brandId: string; workflowCount: number; value: number } | null = null;
      let bestCostPerReply: { brandId: string; workflowCount: number; value: number } | null = null;

      for (const [bId, brandScores] of brandMap) {
        const totalCost = brandScores.reduce((s, e) => s + e.totalCost, 0);
        const hasRuns = brandScores.some((s) => s.completedRuns > 0);
        if (!hasRuns) continue;

        const totalOpened = brandScores.reduce(
          (s, e) => s + e.emailStats.transactional.opened + e.emailStats.broadcast.opened,
          0,
        );
        if (totalOpened > 0) {
          const costPerOpen = totalCost / totalOpened;
          if (!bestCostPerOpen || costPerOpen < bestCostPerOpen.value) {
            bestCostPerOpen = { brandId: bId, workflowCount: brandScores.length, value: Math.round(costPerOpen * 100) / 100 };
          }
        }

        const totalReplied = brandScores.reduce(
          (s, e) => s + e.emailStats.transactional.replied + e.emailStats.broadcast.replied,
          0,
        );
        if (totalReplied > 0) {
          const costPerReply = totalCost / totalReplied;
          if (!bestCostPerReply || costPerReply < bestCostPerReply.value) {
            bestCostPerReply = { brandId: bId, workflowCount: brandScores.length, value: Math.round(costPerReply * 100) / 100 };
          }
        }
      }

      res.json({ bestCostPerOpen, bestCostPerReply });
    } else {
      // by=workflow (default) — existing behavior
      let bestCostPerOpen: { score: WorkflowScore; value: number } | null = null;
      let bestCostPerReply: { score: WorkflowScore; value: number } | null = null;

      for (const s of scores) {
        if (s.completedRuns === 0) continue;

        const totalOpened = s.emailStats.transactional.opened + s.emailStats.broadcast.opened;
        if (totalOpened > 0) {
          const costPerOpen = s.totalCost / totalOpened;
          if (!bestCostPerOpen || costPerOpen < bestCostPerOpen.value) {
            bestCostPerOpen = { score: s, value: costPerOpen };
          }
        }

        const totalReplied = s.emailStats.transactional.replied + s.emailStats.broadcast.replied;
        if (totalReplied > 0) {
          const costPerReply = s.totalCost / totalReplied;
          if (!bestCostPerReply || costPerReply < bestCostPerReply.value) {
            bestCostPerReply = { score: s, value: costPerReply };
          }
        }
      }

      function formatRecord(entry: { score: WorkflowScore; value: number } | null) {
        if (!entry) return null;
        return {
          workflowId: entry.score.workflow.id,
          workflowName: entry.score.workflow.name,
          displayName: entry.score.workflow.displayName,
          brandId: entry.score.workflow.brandId,
          value: Math.round(entry.value * 100) / 100,
        };
      }

      res.json({
        bestCostPerOpen: formatRecord(bestCostPerOpen),
        bestCostPerReply: formatRecord(bestCostPerReply),
      });
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "best")) {
      console.error("[workflow-service] GET best error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /workflows — List workflows (defaults to active only; ?status=all for all)
router.get("/workflows", requireApiKey, async (req, res) => {
  try {
    const { orgId, brandId, humanId, campaignId, category, channel, audienceType, tag, status } = req.query;

    const conditions: ReturnType<typeof eq>[] = [];

    // Default to active workflows unless ?status=all is passed
    if (status !== "all") {
      conditions.push(eq(workflows.status, typeof status === "string" ? status : "active"));
    }

    if (orgId && typeof orgId === "string") {
      conditions.push(eq(workflows.orgId, orgId));
    }
    if (brandId && typeof brandId === "string") {
      conditions.push(eq(workflows.brandId, brandId));
    }
    if (humanId && typeof humanId === "string") {
      conditions.push(eq(workflows.humanId, humanId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflows.campaignId, campaignId));
    }
    if (category && typeof category === "string") {
      conditions.push(eq(workflows.category, category));
    }
    if (channel && typeof channel === "string") {
      conditions.push(eq(workflows.channel, channel));
    }
    if (audienceType && typeof audienceType === "string") {
      conditions.push(eq(workflows.audienceType, audienceType));
    }
    if (tag && typeof tag === "string") {
      conditions.push(sql`${workflows.tags} @> ${JSON.stringify([tag])}::jsonb`);
    }

    const results = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    res.json({ workflows: results.map(formatWorkflow) });
  } catch (err) {
    console.error("[workflow-service] GET list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/:id — Get one workflow
router.get("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    res.json(formatWorkflow(workflow));
  } catch (err) {
    console.error("[workflow-service] GET by id error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/:id/required-providers — Compute required BYOK providers for a workflow
router.get("/workflows/:id/required-providers", requireApiKey, async (req, res) => {
  try {
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const dag = workflow.dag as DAG;
    const endpoints = extractHttpEndpoints(dag);

    if (endpoints.length === 0) {
      res.json({ endpoints: [], requirements: [], providers: [] });
      return;
    }

    const result = await fetchProviderRequirements(endpoints, identity);

    res.json({
      endpoints,
      requirements: result.requirements,
      providers: enrichProvidersWithDomains(result.providers),
    });
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("key-service error:")) {
      console.error("[workflow-service] required-providers: key-service error:", err.message);
      res.status(502).json({ error: err.message });
      return;
    }
    if (err instanceof Error && err.message.includes("KEY_SERVICE_URL")) {
      res.status(502).json({ error: err.message });
      return;
    }
    console.error("[workflow-service] required-providers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/:id — Fork a workflow (DAG change creates a new workflow; metadata-only updates in-place)
router.put("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const body = UpdateWorkflowSchema.parse(req.body);
    const orgId = res.locals.orgId as string;

    const [existing] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // No DAG provided — metadata-only in-place update
    if (!body.dag) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;

      const [updated] = await db
        .update(workflows)
        .set(updates)
        .where(eq(workflows.id, req.params.id))
        .returning();

      res.json(formatWorkflow(updated));
      return;
    }

    // DAG provided — validate it
    const dag = body.dag as DAG;
    const validation = validateDAG(dag);
    if (!validation.valid) {
      res.status(400).json({ error: "Invalid DAG", details: validation.errors });
      return;
    }

    const newSignature = computeDAGSignature(body.dag);

    // Same signature — no structural change, update in-place
    if (newSignature === existing.signature) {
      const updates: Record<string, unknown> = { updatedAt: new Date(), dag: body.dag };
      if (body.name) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;

      const flowName = body.name ?? existing.name;
      const openFlow = dagToOpenFlow(dag, flowName);
      if (existing.windmillFlowPath) {
        const client = getWindmillClient();
        if (client) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: flowName,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflow-service] Failed to update flow in Windmill:", err);
          }
        }
      }

      const [updated] = await db
        .update(workflows)
        .set(updates)
        .where(eq(workflows.id, req.params.id))
        .returning();

      res.json(formatWorkflow(updated));
      return;
    }

    // Different signature — FORK: create a new workflow, keep original untouched
    // Check for existing active workflow with same signature (would violate unique index)
    const [conflicting] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.signature, newSignature),
          eq(workflows.status, "active"),
        )
      );

    if (conflicting) {
      res.status(409).json({
        error: "A workflow with this DAG signature already exists",
        existingWorkflowId: conflicting.id,
        existingWorkflowName: conflicting.name,
      });
      return;
    }

    // Generate new signatureName
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.orgId, orgId));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));
    const signatureName = pickSignatureName(newSignature, usedNames);

    // Build new name from original's dimensions + new signatureName
    const newName = `${existing.category}-${existing.channel}-${existing.audienceType}-${signatureName}`;

    const openFlow = dagToOpenFlow(dag, newName);
    const flowPath = generateFlowPath(orgId, newName);
    const client = getWindmillClient();

    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: newName,
          description: body.description ?? existing.description ?? undefined,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflow-service] Failed to create forked flow in Windmill:", err);
      }
    }

    const [forked] = await db
      .insert(workflows)
      .values({
        orgId: existing.orgId,
        brandId: existing.brandId,
        humanId: existing.humanId,
        campaignId: existing.campaignId,
        subrequestId: existing.subrequestId,
        styleName: existing.styleName,
        name: newName,
        displayName: body.name ?? existing.displayName,
        description: body.description ?? existing.description,
        category: existing.category,
        channel: existing.channel,
        audienceType: existing.audienceType,
        tags: body.tags ?? (existing.tags as string[]) ?? [],
        signature: newSignature,
        signatureName,
        dag: body.dag,
        status: "active",
        forkedFrom: existing.id,
        windmillFlowPath: flowPath,
        createdByUserId: res.locals.userId as string,
        createdByRunId: res.locals.runId as string,
      })
      .returning();

    console.log(
      `[workflow-service] fork: "${existing.name}" (${existing.id}) -> "${newName}" (${forked.id})`,
    );

    res.status(201).json(formatWorkflow(forked));
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] PUT fork error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workflows/:id — Hard delete
router.delete("/workflows/:id", requireApiKey, async (req, res) => {
  try {
    const [existing] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!existing) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    // Delete from Windmill (if configured)
    if (existing.windmillFlowPath) {
      const client = getWindmillClient();
      if (client) {
        try {
          await client.deleteFlow(existing.windmillFlowPath);
        } catch (err) {
          console.error(
            "[workflow-service] Failed to delete flow in Windmill:",
            err
          );
        }
      }
    }

    await db
      .delete(workflows)
      .where(eq(workflows.id, req.params.id));

    res.json({ message: "Workflow deleted" });
  } catch (err) {
    console.error("[workflow-service] DELETE error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /workflows/:id/validate — Validate DAG structure + template contracts
router.post("/workflows/:id/validate", requireApiKey, async (req, res) => {
  try {
    const [workflow] = await db
      .select()
      .from(workflows)
      .where(eq(workflows.id, req.params.id));

    if (!workflow) {
      res.status(404).json({ error: "Workflow not found" });
      return;
    }

    const dag = workflow.dag as DAG;
    const validation = validateDAG(dag);

    // Template contract validation (best-effort — doesn't block if content-gen is unreachable)
    let templateContract: { valid: boolean; templateRefs: TemplateRef[]; issues: TemplateContractIssue[] } | undefined;
    try {
      const templateRefs = extractTemplateRefs(dag);
      if (templateRefs.length > 0) {
        const types = templateRefs.map((r) => r.templateType);
        const templates = await fetchPromptTemplates(types);
        templateContract = validateTemplateContracts(dag, templates);
      }
    } catch (err) {
      console.warn("[workflow-service] Template contract check skipped:", err instanceof Error ? err.message : err);
    }

    const result: Record<string, unknown> = { ...validation };
    if (templateContract) {
      result.valid = validation.valid && templateContract.valid;
      result.templateContract = templateContract;
    }

    res.json(result);
  } catch (err) {
    console.error("[workflow-service] VALIDATE error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
