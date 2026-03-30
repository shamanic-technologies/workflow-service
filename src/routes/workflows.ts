import { Router } from "express";
import { eq, and, sql } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { db } from "../db/index.js";
import { workflows, workflowRuns } from "../db/schema.js";
import { requireApiKey } from "../middleware/auth.js";
import { createRateLimit } from "../middleware/rate-limit.js";
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
  RankedWorkflowObjectiveSchema,
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
  rescoreForObjective,
  formatScoreItem,
  aggregateSectionStats,
  handleExternalServiceError,
  type WorkflowScore,
} from "../lib/workflow-scoring.js";
import { resolveFeatureDynasty, fetchFeatureOutputs, fetchStatsRegistry } from "../lib/features-client.js";

const router = Router();

/** Default metrics when feature outputs can't be resolved or no featureSlug is provided. */
const DEFAULT_OBJECTIVES = ["emailsReplied"];

/**
 * Resolves which stats keys to use as ranking objectives.
 * - If explicit objective is provided, use it alone.
 * - If featureSlug is provided, fetch its outputs and filter to count-type metrics.
 * - Otherwise, fall back to DEFAULT_OBJECTIVES.
 */
async function resolveObjectives(
  objective: string | undefined,
  featureSlug: string | undefined,
): Promise<string[]> {
  if (objective) return [objective];

  if (featureSlug) {
    const [outputs, registry] = await Promise.all([
      fetchFeatureOutputs(featureSlug),
      fetchStatsRegistry(),
    ]);
    const countMetrics = outputs
      .map((o) => o.key)
      .filter((key) => {
        const entry = registry[key];
        return entry && entry.type === "count";
      });
    if (countMetrics.length > 0) return countMetrics;
  }

  return DEFAULT_OBJECTIVES;
}

function formatWorkflow(w: typeof workflows.$inferSelect) {
  return {
    ...w,
    createdAt: w.createdAt?.toISOString() ?? null,
    updatedAt: w.updatedAt?.toISOString() ?? null,
  };
}

function generateFlowPath(scope: string, slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `f/workflows/${scope}/${sanitized}`;
}

/** Compose slug with version suffix: no -v1 for v1, -v2 for v2+. */
function composeSlug(base: string, version: number): string {
  return version >= 2 ? `${base}-v${version}` : base;
}

/** Compose display name with version suffix: no v1 for v1, v2 for v2+. */
function composeName(base: string, version: number): string {
  return version >= 2 ? `${base} v${version}` : base;
}

// POST /workflows/generate — Generate a workflow from natural language
router.post("/workflows/generate", requireApiKey, createRateLimit, async (req, res) => {
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
      .where(sql`true`);
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));

    // Match by featureSlug — one active workflow per featureSlug
    const [existing] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.featureSlug, body.featureSlug),
          eq(workflows.status, "active"),
        )
      );

    type DeployResult = {
      id: string;
      slug: string;
      name: string;
      featureSlug: string;
      tags: string[];
      signature: string;
      signatureName: string;
      action: "created" | "updated";
    };

    let result: DeployResult;

    if (existing && existing.signature === signature) {
      const openFlow = dagToOpenFlow(dag, existing.slug);
      const client = getWindmillClient();
      if (client && existing.windmillFlowPath) {
        try {
          await client.updateFlow(existing.windmillFlowPath, {
            summary: existing.slug,
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
        slug: updated.slug,
        name: updated.name,
        featureSlug: updated.featureSlug,
        tags: (updated.tags as string[]) ?? [],
        signature: updated.signature,
        signatureName: updated.signatureName,
        action: "updated",
      };
    } else {
      let signatureName: string;
      let styleName: string | null = null;
      let humanId: string | null = null;
      let createdForBrandId: string | null = null;

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

        if (body.style.type === "human" && body.style.humanId) {
          humanId = body.style.humanId;
        }
        if (body.style.type === "brand" && body.style.brandId) {
          createdForBrandId = body.style.brandId;
        }
      } else {
        signatureName = pickSignatureName(signature, usedNames);
      }

      const dynasty = await resolveFeatureDynasty(body.featureSlug);
      const dynastyName = `${dynasty.featureDynastyName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
      const dynastySlug = `${dynasty.featureDynastySlug}-${signatureName}`;
      const newVersion = existing ? existing.version + 1 : 1;
      const slug = composeSlug(dynastySlug, newVersion);
      const name = composeName(dynastyName, newVersion);

      const openFlow = dagToOpenFlow(dag, slug);
      const flowPath = generateFlowPath(orgId, slug);
      const client = getWindmillClient();

      if (client) {
        try {
          await client.createFlow({
            path: flowPath,
            summary: slug,
            description: generated.description,
            value: openFlow.value,
            schema: openFlow.schema,
          });
        } catch (err) {
          console.error("[workflow-service] generate: failed to create Windmill flow:", err);
        }
      }

      // Deprecate existing if upgrading
      if (existing) {
        await db
          .update(workflows)
          .set({ status: "deprecated", updatedAt: new Date() })
          .where(eq(workflows.id, existing.id));
      }

      const [created] = await db
        .insert(workflows)
        .values({
          orgId,
          slug,
          name,
          dynastyName,
          dynastySlug,
          description: generated.description,
          featureSlug: body.featureSlug,
          category: generated.category,
          channel: generated.channel,
          audienceType: generated.audienceType,
          signature,
          signatureName,
          version: newVersion,
          dag: generated.dag,
          windmillFlowPath: flowPath,
          humanId,
          createdForBrandId,
          styleName,
          createdByUserId: userId,
          createdByRunId: runId,
        })
        .returning();

      // Set upgradedTo pointer on the deprecated workflow
      if (existing) {
        await db
          .update(workflows)
          .set({ upgradedTo: created.id })
          .where(eq(workflows.id, existing.id));
      }

      result = {
        id: created.id,
        slug: created.slug,
        name: created.name,
        featureSlug: created.featureSlug,
        tags: (created.tags as string[]) ?? [],
        signature: created.signature,
        signatureName: created.signatureName,
        action: existing ? "updated" : "created",
      };
    }

    res.json({
      workflow: result,
      dag: generated.dag,
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
router.post("/workflows", requireApiKey, createRateLimit, async (req, res) => {
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

    // Compute signature and naming
    const signature = computeDAGSignature(body.dag);
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(eq(workflows.status, "active"));
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));
    const signatureName = pickSignatureName(signature, usedNames);

    const dynasty = await resolveFeatureDynasty(body.featureSlug);
    const dynastyName = `${dynasty.featureDynastyName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
    const dynastySlug = `${dynasty.featureDynastySlug}-${signatureName}`;
    const slug = dynastySlug;
    const name = dynastyName;

    // Translate to OpenFlow
    const openFlow = dagToOpenFlow(dag, slug);
    const flowPath = generateFlowPath(orgId, slug);

    // Push to Windmill (if configured)
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: slug,
          description: body.description,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        console.error("[workflow-service] Failed to create flow in Windmill:", err);
      }
    }

    // Store in DB
    const [workflow] = await db
      .insert(workflows)
      .values({
        orgId,
        createdForBrandId: body.createdForBrandId,
        featureSlug: body.featureSlug,
        campaignId: body.campaignId,
        subrequestId: body.subrequestId,
        slug,
        name,
        dynastyName,
        dynastySlug,
        description: body.description,
        category: body.category,
        channel: body.channel,
        audienceType: body.audienceType,
        tags: body.tags ?? [],
        signature,
        signatureName,
        version: 1,
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

// PUT /workflows/upgrade — Batch upsert workflows by (orgId + signature)
router.put("/workflows/upgrade", requireApiKey, async (req, res) => {
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

    // Fetch all existing signatureNames to avoid collisions (include deprecated)
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(sql`true`);
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));

    const results: { id: string; slug: string; name: string; dynastySlug: string; featureSlug: string; tags: string[]; signature: string; signatureName: string; version: number; action: "created" | "updated" | "deprecated-to-existing" }[] = [];

    for (const wf of body.workflows) {
      const dag = wf.dag as DAG;
      const signature = computeDAGSignature(wf.dag);

      // Match by featureSlug — one active workflow per featureSlug
      const [activeForFeature] = await db
        .select()
        .from(workflows)
        .where(
          and(
            eq(workflows.featureSlug, wf.featureSlug),
            eq(workflows.status, "active"),
          )
        );

      if (activeForFeature && activeForFeature.signature === signature) {
        // Same DAG already deployed — update metadata in-place
        console.log(
          `[workflow-service] deploy: sig=${signature.slice(0, 12)} matched "${activeForFeature.slug}" (${activeForFeature.id}) -> update`,
        );
        const openFlow = dagToOpenFlow(dag, activeForFeature.slug);
        const client = getWindmillClient();

        if (client && activeForFeature.windmillFlowPath) {
          try {
            await client.updateFlow(activeForFeature.windmillFlowPath, {
              summary: activeForFeature.slug,
              description: wf.description,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (err) {
            console.error("[workflow-service] deploy: failed to update Windmill flow:", err);
          }
        }

        const updatedTags = wf.tags ?? (activeForFeature.tags as string[]) ?? [];
        const [updated] = await db
          .update(workflows)
          .set({
            orgId,
            createdForBrandId: wf.createdForBrandId,
            featureSlug: wf.featureSlug ?? activeForFeature.featureSlug,
            description: wf.description ?? activeForFeature.description,
            category: wf.category,
            channel: wf.channel,
            audienceType: wf.audienceType,
            tags: updatedTags,
            dag: wf.dag,
            updatedAt: new Date(),
          })
          .where(eq(workflows.id, activeForFeature.id))
          .returning();

        results.push({
          id: updated.id,
          slug: updated.slug,
          name: updated.name,
          dynastySlug: updated.dynastySlug,
          featureSlug: updated.featureSlug,
          tags: (updated.tags as string[]) ?? [],
          signature: updated.signature,
          signatureName: updated.signatureName,
          version: updated.version,
          action: "updated",
        });
      } else if (activeForFeature) {
        // DAG changed — check if another active workflow already has this signature (convergence)
        const [convergenceTarget] = await db
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.featureSlug, wf.featureSlug),
              eq(workflows.signature, signature),
              eq(workflows.status, "active"),
            )
          );

        if (convergenceTarget) {
          // Convergence: deprecate our predecessor, point to the existing active
          console.log(
            `[workflow-service] deploy: convergence — "${activeForFeature.slug}" -> existing "${convergenceTarget.slug}"`,
          );

          await db
            .update(workflows)
            .set({
              status: "deprecated",
              upgradedTo: convergenceTarget.id,
              updatedAt: new Date(),
            })
            .where(eq(workflows.id, activeForFeature.id));

          results.push({
            id: convergenceTarget.id,
            slug: convergenceTarget.slug,
            name: convergenceTarget.name,
            dynastySlug: convergenceTarget.dynastySlug,
            featureSlug: convergenceTarget.featureSlug,
            tags: (convergenceTarget.tags as string[]) ?? [],
            signature: convergenceTarget.signature,
            signatureName: convergenceTarget.signatureName,
            version: convergenceTarget.version,
            action: "deprecated-to-existing",
          });
        } else {
          // Upgrade: deprecate old, create new version in the same dynasty
          const newVersion = activeForFeature.version + 1;
          const dynastyName = activeForFeature.dynastyName;
          const dynastySlug = activeForFeature.dynastySlug;
          const signatureName = activeForFeature.signatureName;

          // Use dynastySlug as the base for versioned slugs
          const baseSlug = dynastySlug;
          const newSlug = composeSlug(baseSlug, newVersion);
          const newName = composeName(dynastyName, newVersion);

          console.log(
            `[workflow-service] deploy: sig=${signature.slice(0, 12)} upgrade "${activeForFeature.slug}" -> "${newSlug}" (v${newVersion})`,
          );

          const openFlow = dagToOpenFlow(dag, newSlug);
          const flowPath = generateFlowPath(orgId, newSlug);
          const client = getWindmillClient();

          if (client) {
            try {
              await client.createFlow({
                path: flowPath,
                summary: newSlug,
                description: wf.description,
                value: openFlow.value,
                schema: openFlow.schema,
              });
            } catch (err) {
              console.error("[workflow-service] deploy: failed to create Windmill flow:", err);
            }
          }

          // Deprecate old workflow FIRST
          await db
            .update(workflows)
            .set({
              status: "deprecated",
              updatedAt: new Date(),
            })
            .where(eq(workflows.id, activeForFeature.id));

          const [created] = await db
            .insert(workflows)
            .values({
              orgId,
              createdForBrandId: wf.createdForBrandId,
              featureSlug: wf.featureSlug,
              slug: newSlug,
              name: newName,
              dynastyName,
              dynastySlug,
              description: wf.description,
              category: wf.category,
              channel: wf.channel,
              audienceType: wf.audienceType,
              tags: wf.tags ?? [],
              signature,
              signatureName,
              version: newVersion,
              dag: wf.dag,
              windmillFlowPath: flowPath,
              createdByUserId: res.locals.userId as string,
              createdByRunId: res.locals.runId as string,
            })
            .returning();

          // Set upgradedTo pointer on the deprecated workflow
          await db
            .update(workflows)
            .set({ upgradedTo: created.id })
            .where(eq(workflows.id, activeForFeature.id));

          results.push({
            id: created.id,
            slug: created.slug,
            name: created.name,
            dynastySlug: created.dynastySlug,
            featureSlug: created.featureSlug,
            tags: (created.tags as string[]) ?? [],
            signature: created.signature,
            signatureName: created.signatureName,
            version: created.version,
            action: "created",
          });
        }
      } else {
        // No active workflow for this featureSlug — new dynasty
        const signatureName = pickSignatureName(signature, usedNames);
        usedNames.add(signatureName);

        const dynasty = await resolveFeatureDynasty(wf.featureSlug);
        const dynastyName = `${dynasty.featureDynastyName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
        const dynastySlug = `${dynasty.featureDynastySlug}-${signatureName}`;
        const slug = dynastySlug;
        const name = dynastyName;

        console.log(
          `[workflow-service] deploy: sig=${signature.slice(0, 12)} new dynasty -> "${slug}"`,
        );

        const openFlow = dagToOpenFlow(dag, slug);
        const flowPath = generateFlowPath(orgId, slug);
        const client = getWindmillClient();

        if (client) {
          try {
            await client.createFlow({
              path: flowPath,
              summary: slug,
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
            createdForBrandId: wf.createdForBrandId,
            featureSlug: wf.featureSlug,
            slug,
            name,
            dynastyName,
            dynastySlug,
            description: wf.description,
            category: wf.category,
            channel: wf.channel,
            audienceType: wf.audienceType,
            tags: wf.tags ?? [],
            signature,
            signatureName,
            version: 1,
            dag: wf.dag,
            windmillFlowPath: flowPath,
            createdByUserId: res.locals.userId as string,
            createdByRunId: res.locals.runId as string,
          })
          .returning();

        results.push({
          id: created.id,
          slug: created.slug,
          name: created.name,
          dynastySlug: created.dynastySlug,
          featureSlug: created.featureSlug,
          tags: (created.tags as string[]) ?? [],
          signature: created.signature,
          signatureName: created.signatureName,
          version: created.version,
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
    const { orgId, brandId, featureSlug, objective, limit, groupBy } = query.data;
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (featureSlug) conditions.push(eq(workflows.featureSlug, featureSlug));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");

    if (activeWorkflows.length === 0) {
      res.json({ results: [] });
      return;
    }

    // Resolve which metrics to rank by (from feature outputs or explicit objective)
    const objectives = await resolveObjectives(objective, featureSlug);

    // Fetch base scores once — objective only affects outcome computation, which we re-score per metric
    const { scores, runBrandMap, workflowRunIds } = await computeWorkflowScores(activeWorkflows, [], objectives[0], { kind: "auth", identity });

    // Helper: produce rankings for a given set of scores across all objectives
    function rankForObjectives(inputScores: WorkflowScore[]) {
      if (objectives.length === 1) {
        // Single objective — re-score if needed, return flat ranked list
        const rescored = rescoreForObjective(inputScores, objectives[0]);
        return rankScores(rescored).slice(0, limit).map(formatScoreItem);
      }
      // Multiple objectives — return per-metric rankings
      const rankings: Record<string, ReturnType<typeof formatScoreItem>[]> = {};
      for (const obj of objectives) {
        const rescored = rescoreForObjective(inputScores, obj);
        rankings[obj] = rankScores(rescored).slice(0, limit).map(formatScoreItem);
      }
      return rankings;
    }

    if (groupBy === "feature") {
      // Group by featureSlug
      const featureMap = new Map<string, WorkflowScore[]>();
      for (const score of scores) {
        const key = score.workflow.featureSlug;
        const arr = featureMap.get(key) ?? [];
        arr.push(score);
        featureMap.set(key, arr);
      }

      const features = [...featureMap.entries()].map(([featureSlug, featureScores]) => ({
        featureSlug,
        stats: aggregateSectionStats(featureScores),
        workflows: rankForObjectives(featureScores),
      }));

      res.json({ features });
    } else if (groupBy === "brand") {
      // Group by brandId from runs — a workflow can appear under multiple brands
      const brandRunIds = new Map<string, Set<string>>();
      const brandWorkflowIds = new Map<string, Set<string>>();

      for (const score of scores) {
        const runIds = workflowRunIds[score.workflow.id] ?? [];
        for (const runId of runIds) {
          const bId = runBrandMap.get(runId);
          if (!bId) continue;
          if (!brandRunIds.has(bId)) brandRunIds.set(bId, new Set());
          if (!brandWorkflowIds.has(bId)) brandWorkflowIds.set(bId, new Set());
          brandRunIds.get(bId)!.add(runId);
          brandWorkflowIds.get(bId)!.add(score.workflow.id);
        }
      }

      // If brandId filter is set, only return that brand
      const brandEntries = brandId
        ? [...brandRunIds.entries()].filter(([bId]) => bId === brandId)
        : [...brandRunIds.entries()];

      const brands = brandEntries.map(([bId]) => {
        const wfIds = brandWorkflowIds.get(bId)!;
        const brandScores = scores.filter((s) => wfIds.has(s.workflow.id));
        return {
          brandId: bId,
          stats: aggregateSectionStats(brandScores),
          workflows: rankForObjectives(brandScores),
        };
      });

      res.json({ brands });
    } else {
      // If brandId filter is set, only include workflows that have runs for that brand
      let filteredScores = scores;
      if (brandId) {
        const wfIdsForBrand = new Set<string>();
        for (const score of scores) {
          const runIds = workflowRunIds[score.workflow.id] ?? [];
          for (const runId of runIds) {
            if (runBrandMap.get(runId) === brandId) {
              wfIdsForBrand.add(score.workflow.id);
              break;
            }
          }
        }
        filteredScores = scores.filter((s) => wfIdsForBrand.has(s.workflow.id));
      }

      if (objectives.length === 1) {
        const rescored = rescoreForObjective(filteredScores, objectives[0]);
        const ranked = rankScores(rescored).slice(0, limit);
        res.json({ results: ranked.map(formatScoreItem) });
      } else {
        const rankings: Record<string, ReturnType<typeof formatScoreItem>[]> = {};
        for (const obj of objectives) {
          const rescored = rescoreForObjective(filteredScores, obj);
          rankings[obj] = rankScores(rescored).slice(0, limit).map(formatScoreItem);
        }
        res.json({ rankings });
      }
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "ranked")) {
      console.error("[workflow-service] GET ranked error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /workflows/best — Hero records: best cost-per-metric for each feature output metric
router.get("/workflows/best", requireApiKey, async (req, res) => {
  try {
    const query = BestWorkflowQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: "Validation error", details: query.error });
      return;
    }
    const { orgId, brandId, featureSlug, by } = query.data;
    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    // Resolve which metrics to compute best records for
    const objectives = await resolveObjectives(undefined, featureSlug);

    const conditions: ReturnType<typeof eq>[] = [];
    if (orgId) conditions.push(eq(workflows.orgId, orgId));
    if (featureSlug) conditions.push(eq(workflows.featureSlug, featureSlug));

    const allMatchingWorkflows = conditions.length > 0
      ? await db.select().from(workflows).where(and(...conditions))
      : await db.select().from(workflows);

    const activeWorkflows = allMatchingWorkflows.filter((w) => w.status === "active");

    if (activeWorkflows.length === 0) {
      const best: Record<string, null> = {};
      for (const obj of objectives) best[obj] = null;
      res.json({ best });
      return;
    }

    // Slug-level stats only — no dynasty chain aggregation
    const { scores, runBrandMap, workflowRunIds } = await computeWorkflowScores(activeWorkflows, [], objectives[0], { kind: "auth", identity });

    if (by === "brand") {
      // Aggregate by brandId from runs
      const brandScoresMap = new Map<string, WorkflowScore[]>();
      for (const s of scores) {
        const runIds = workflowRunIds[s.workflow.id] ?? [];
        for (const runId of runIds) {
          const bId = runBrandMap.get(runId);
          if (!bId) continue;
          if (!brandScoresMap.has(bId)) brandScoresMap.set(bId, []);
          const arr = brandScoresMap.get(bId)!;
          if (!arr.some((existing) => existing.workflow.id === s.workflow.id)) {
            arr.push(s);
          }
        }
      }

      const brandEntries = brandId
        ? [...brandScoresMap.entries()].filter(([bId]) => bId === brandId)
        : [...brandScoresMap.entries()];

      const best: Record<string, { brandId: string; workflowCount: number; value: number } | null> = {};
      for (const obj of objectives) {
        let bestForMetric: { brandId: string; workflowCount: number; value: number } | null = null;

        for (const [bId, brandScores] of brandEntries) {
          const totalCost = brandScores.reduce((s, e) => s + e.totalCost, 0);
          const hasRuns = brandScores.some((s) => s.completedRuns > 0);
          if (!hasRuns) continue;

          const rescored = rescoreForObjective(brandScores, obj);
          const totalOutcomes = rescored.reduce((s, e) => s + e.totalOutcomes, 0);
          if (totalOutcomes > 0) {
            const costPer = totalCost / totalOutcomes;
            if (!bestForMetric || costPer < bestForMetric.value) {
              bestForMetric = { brandId: bId, workflowCount: brandScores.length, value: Math.round(costPer * 100) / 100 };
            }
          }
        }

        best[obj] = bestForMetric;
      }

      res.json({ best });
    } else {
      // by=workflow (default)
      const best: Record<string, { workflowId: string; workflowSlug: string; workflowName: string; createdForBrandId: string | null; value: number } | null> = {};

      for (const obj of objectives) {
        let bestForMetric: { score: WorkflowScore; value: number } | null = null;
        const rescored = rescoreForObjective(scores, obj);

        for (const s of rescored) {
          if (s.completedRuns === 0) continue;
          if (s.totalOutcomes > 0) {
            const costPer = s.totalCost / s.totalOutcomes;
            if (!bestForMetric || costPer < bestForMetric.value) {
              bestForMetric = { score: s, value: costPer };
            }
          }
        }

        best[obj] = bestForMetric
          ? {
              workflowId: bestForMetric.score.workflow.id,
              workflowSlug: bestForMetric.score.workflow.slug,
              workflowName: bestForMetric.score.workflow.name,
              createdForBrandId: bestForMetric.score.workflow.createdForBrandId,
              value: Math.round(bestForMetric.value * 100) / 100,
            }
          : null;
      }

      res.json({ best });
    }
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "best")) {
      console.error("[workflow-service] GET best error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /workflows/dynasties — List all dynasties with their versioned slugs
router.get("/workflows/dynasties", requireApiKey, async (req, res) => {
  try {
    const allWorkflows = await db
      .select({ slug: workflows.slug, dynastySlug: workflows.dynastySlug, dynastyName: workflows.dynastyName })
      .from(workflows);

    const dynastyMap = new Map<string, { dynastyName: string; slugs: string[] }>();
    for (const w of allWorkflows) {
      const entry = dynastyMap.get(w.dynastySlug);
      if (entry) {
        entry.slugs.push(w.slug);
      } else {
        dynastyMap.set(w.dynastySlug, { dynastyName: w.dynastyName, slugs: [w.slug] });
      }
    }

    const dynasties = [...dynastyMap.entries()].map(([dynastySlug, { dynastyName, slugs }]) => ({
      dynastySlug,
      dynastyName,
      slugs,
    }));

    res.json({ dynasties });
  } catch (err) {
    console.error("[workflow-service] GET dynasties error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/dynasty/slugs — Resolve a dynasty slug to all versioned workflow slugs
router.get("/workflows/dynasty/slugs", requireApiKey, async (req, res) => {
  try {
    const dynastySlug = req.query.dynastySlug;
    if (!dynastySlug || typeof dynastySlug !== "string") {
      res.status(400).json({ error: "Missing required query parameter: dynastySlug" });
      return;
    }

    const matching = await db
      .select({ slug: workflows.slug, dynastyName: workflows.dynastyName })
      .from(workflows)
      .where(eq(workflows.dynastySlug, dynastySlug));

    if (matching.length === 0) {
      res.status(404).json({ error: `No workflows found for dynastySlug: ${dynastySlug}` });
      return;
    }

    res.json({
      dynastySlug,
      dynastyName: matching[0].dynastyName,
      slugs: matching.map((w) => w.slug),
    });
  } catch (err) {
    console.error("[workflow-service] GET dynasty/slugs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/dynasty/stats — Aggregated stats for a dynasty (full upgrade chain)
router.get("/workflows/dynasty/stats", requireApiKey, async (req, res) => {
  try {
    const dynastySlug = req.query.dynastySlug;
    if (!dynastySlug || typeof dynastySlug !== "string") {
      res.status(400).json({ error: "Missing required query parameter: dynastySlug" });
      return;
    }

    const objectiveParam = req.query.objective;
    const objective = (typeof objectiveParam === "string" && objectiveParam) ? objectiveParam : "replies";

    const identity = {
      orgId: res.locals.orgId as string,
      userId: res.locals.userId as string,
      runId: res.locals.runId as string,
    };

    const allDynastyWorkflows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.dynastySlug, dynastySlug));

    if (allDynastyWorkflows.length === 0) {
      res.status(404).json({ error: `No workflows found for dynastySlug: ${dynastySlug}` });
      return;
    }

    const activeWorkflows = allDynastyWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allDynastyWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.json({
        dynastySlug,
        dynastyName: allDynastyWorkflows[0].dynastyName,
        stats: {
          totalCostInUsdCents: 0,
          totalOutcomes: 0,
          costPerOutcome: null,
          completedRuns: 0,
          email: {
            transactional: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, recipients: 0 },
            broadcast: { sent: 0, delivered: 0, opened: 0, clicked: 0, replied: 0, bounced: 0, unsubscribed: 0, recipients: 0 },
          },
        },
      });
      return;
    }

    // Dynasty-level: pass all deprecated workflows so chain aggregation happens
    const { scores } = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, objective, { kind: "auth", identity });

    const stats = aggregateSectionStats(scores);

    res.json({
      dynastySlug,
      dynastyName: allDynastyWorkflows[0].dynastyName,
      stats,
    });
  } catch (err: unknown) {
    if (!handleExternalServiceError(err, res, "dynasty/stats")) {
      console.error("[workflow-service] GET dynasty/stats error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// GET /workflows — List workflows (defaults to active only; ?status=all for all)
router.get("/workflows", requireApiKey, async (req, res) => {
  try {
    const { orgId, brandId, humanId, campaignId, featureSlug, tag, status } = req.query;

    const conditions: ReturnType<typeof eq>[] = [];

    // Default to active workflows unless ?status=all is passed
    if (status !== "all") {
      conditions.push(eq(workflows.status, typeof status === "string" ? status : "active"));
    }

    if (orgId && typeof orgId === "string") {
      conditions.push(eq(workflows.orgId, orgId));
    }
    if (brandId && typeof brandId === "string") {
      conditions.push(eq(workflows.createdForBrandId, brandId));
    }
    if (humanId && typeof humanId === "string") {
      conditions.push(eq(workflows.humanId, humanId));
    }
    if (campaignId && typeof campaignId === "string") {
      conditions.push(eq(workflows.campaignId, campaignId));
    }
    if (featureSlug && typeof featureSlug === "string") {
      conditions.push(eq(workflows.featureSlug, featureSlug));
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
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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
    if (err instanceof TypeError && err.message === "fetch failed") {
      const cause = (err as unknown as { cause?: { code?: string } }).cause;
      const detail = cause?.code ? ` (${cause.code})` : "";
      console.error(`[workflow-service] required-providers: key-service unreachable${detail}`, err);
      res.status(502).json({ error: `key-service unreachable${detail}` });
      return;
    }
    console.error("[workflow-service] required-providers error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /workflows/:id — Update a workflow (metadata or DAG)
// - No DAG → metadata update in-place
// - DAG with same signature → update in-place
// - DAG with new signature → fork (new dynasty), optionally deprecate source dynasty
router.put("/workflows/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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

    // --- Case 1: No DAG provided — metadata-only in-place update ---
    if (!body.dag) {
      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;

      const [updated] = await db
        .update(workflows)
        .set(updates)
        .where(eq(workflows.id, req.params.id))
        .returning();

      res.json({ ...formatWorkflow(updated), _action: "updated" as const });
      return;
    }

    // --- DAG provided — validate it ---
    const dag = body.dag as DAG;
    const validation = validateDAG(dag);
    if (!validation.valid) {
      res.status(400).json({ error: "Invalid DAG", details: validation.errors });
      return;
    }

    const newSignature = computeDAGSignature(body.dag);

    // --- Case 2: Same signature — no structural change, update in-place ---
    if (newSignature === existing.signature) {
      const updates: Record<string, unknown> = { updatedAt: new Date(), dag: body.dag };
      if (body.description !== undefined) updates.description = body.description;
      if (body.tags !== undefined) updates.tags = body.tags;

      const openFlow = dagToOpenFlow(dag, existing.slug);
      if (existing.windmillFlowPath) {
        const client = getWindmillClient();
        if (client) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: existing.slug,
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

      res.json({ ...formatWorkflow(updated), _action: "updated" as const });
      return;
    }

    // --- Case 3: Different signature — FORK: create new workflow in new dynasty ---

    // Check for existing active workflow with same signature (conflict)
    const [conflicting] = await db
      .select()
      .from(workflows)
      .where(
        and(
          eq(workflows.featureSlug, existing.featureSlug),
          eq(workflows.signature, newSignature),
          eq(workflows.status, "active"),
        )
      );

    if (conflicting) {
      res.status(409).json({
        error: "A workflow with this DAG signature already exists",
        existingWorkflowId: conflicting.id,
        existingWorkflowSlug: conflicting.slug,
      });
      return;
    }

    // Generate new signatureName (include deprecated to avoid recycling names)
    const existingWorkflows = await db
      .select({ signatureName: workflows.signatureName })
      .from(workflows)
      .where(sql`true`);
    const usedNames = new Set(existingWorkflows.map((w) => w.signatureName));
    const signatureName = pickSignatureName(newSignature, usedNames);

    // Resolve dynasty naming from features-service
    const dynasty = await resolveFeatureDynasty(existing.featureSlug);
    const baseDynastyName = `${dynasty.featureDynastyName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
    const baseDynastySlug = `${dynasty.featureDynastySlug}-${signatureName}`;
    const newSlug = baseDynastySlug; // version 1, no suffix
    const newName = baseDynastyName; // version 1, no suffix

    const openFlow = dagToOpenFlow(dag, newSlug);
    const flowPath = generateFlowPath(orgId, newSlug);
    const client = getWindmillClient();

    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: newSlug,
          description: body.description ?? existing.description ?? undefined,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes("already exists")) {
          try {
            await client.updateFlow(flowPath, {
              summary: newSlug,
              description: body.description ?? existing.description ?? undefined,
              value: openFlow.value,
              schema: openFlow.schema,
            });
          } catch (updateErr) {
            console.error("[workflow-service] Failed to update existing forked flow in Windmill:", updateErr);
          }
        } else {
          console.error("[workflow-service] Failed to create forked flow in Windmill:", err);
        }
      }
    }

    let forked;
    try {
      const [row] = await db
        .insert(workflows)
        .values({
          orgId: existing.orgId,
          createdForBrandId: existing.createdForBrandId,
          featureSlug: existing.featureSlug,
          humanId: existing.humanId,
          campaignId: existing.campaignId,
          subrequestId: existing.subrequestId,
          styleName: existing.styleName,
          slug: newSlug,
          name: newName,
          dynastyName: baseDynastyName,
          dynastySlug: baseDynastySlug,
          description: body.description ?? existing.description,
          category: existing.category,
          channel: existing.channel,
          audienceType: existing.audienceType,
          tags: body.tags ?? (existing.tags as string[]) ?? [],
          signature: newSignature,
          signatureName,
          version: 1,
          dag: body.dag,
          status: "active",
          forkedFrom: existing.id,
          windmillFlowPath: flowPath,
          createdByUserId: res.locals.userId as string,
          createdByRunId: res.locals.runId as string,
        })
        .returning();
      forked = row;
    } catch (dbErr: unknown) {
      if (dbErr instanceof Error && "code" in dbErr && (dbErr as { code?: string }).code === "23505") {
        res.status(409).json({
          error: "A workflow with this name already exists",
          detail: (dbErr as { detail?: string }).detail,
        });
        return;
      }
      throw dbErr;
    }

    // Determine if the source dynasty should be deprecated:
    // Deprecate ONLY if the entire dynasty has zero campaign runs.
    let sourceDynastyDeprecated = false;
    const dynastyWorkflows = await db
      .select({ id: workflows.id })
      .from(workflows)
      .where(eq(workflows.dynastySlug, existing.dynastySlug));
    const dynastyWorkflowIds = dynastyWorkflows.map((w) => w.id);

    if (dynastyWorkflowIds.length > 0) {
      const campaignRuns = await db
        .select({ id: workflowRuns.id })
        .from(workflowRuns)
        .where(
          and(
            sql`${workflowRuns.workflowId} IN (${sql.join(dynastyWorkflowIds.map(id => sql`${id}`), sql`, `)})`,
            sql`${workflowRuns.campaignId} IS NOT NULL`,
          )
        );

      if (campaignRuns.length === 0) {
        // Dynasty has zero campaign runs — safe to deprecate
        await db
          .update(workflows)
          .set({
            status: "deprecated",
            upgradedTo: forked.id,
            updatedAt: new Date(),
          })
          .where(eq(workflows.id, existing.id));
        sourceDynastyDeprecated = true;

        console.log(
          `[workflow-service] fork+deprecate: "${existing.name}" (${existing.id}) -> "${newName}" (${forked.id}) [dynasty had 0 campaign runs]`,
        );
      } else {
        console.log(
          `[workflow-service] fork: "${existing.name}" (${existing.id}) -> "${newName}" (${forked.id}) [source dynasty kept active: ${campaignRuns.length} campaign run(s)]`,
        );
      }
    }

    res.status(201).json({
      ...formatWorkflow(forked),
      _action: "forked" as const,
      _forkedFromName: existing.name,
      _forkedFromId: existing.id,
      _sourceDynastyDeprecated: sourceDynastyDeprecated,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ZodError") {
      res.status(400).json({ error: "Validation error", details: err });
      return;
    }
    console.error("[workflow-service] PUT update error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /workflows/:id — Hard delete
router.delete("/workflows/:id", requireApiKey, async (req, res) => {
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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
  if (!UUID_RE.test(req.params.id)) {
    res.status(400).json({ error: "Invalid workflow ID format" });
    return;
  }
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
