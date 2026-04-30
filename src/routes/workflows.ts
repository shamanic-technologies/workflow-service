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
import { fetchProviderRequirements } from "../lib/key-service-client.js";
import { enrichProvidersWithDomains } from "../lib/provider-domains.js";
import { extractTemplateRefs, validateTemplateContracts, type TemplateContractIssue, type TemplateRef } from "../lib/validate-template-contracts.js";
import { fetchPromptTemplates } from "../lib/content-generation-client.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { computeWorkflowScores, aggregateSectionStats, handleExternalServiceError } from "../lib/workflow-scoring.js";
import { traceEvent } from "../lib/trace-event.js";

const router = Router();

function formatWorkflow(w: typeof workflows.$inferSelect) {
  const { dynastySlug, dynastyName, ...rest } = w;
  return {
    ...rest,
    workflowDynastySlug: dynastySlug,
    workflowDynastyName: dynastyName,
    createdAt: w.createdAt?.toISOString() ?? null,
    updatedAt: w.updatedAt?.toISOString() ?? null,
  };
}

/** Strip version suffix from slug: "cold-outreach-obsidian-v3" → "cold-outreach-obsidian" */
function toDynastySlug(slug: string): string {
  return slug.replace(/-v\d+$/, "");
}

/** Strip version suffix from name: "Cold Outreach Obsidian v3" → "Cold Outreach Obsidian" */
function toDynastyName(name: string): string {
  return name.replace(/ v\d+$/, "");
}

function generateFlowPath(scope: string, slug: string): string {
  const sanitized = slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return `f/workflows/${scope}/${sanitized}`;
}

/** Convert feature slug to display name: "pr-cold-email-outreach" → "PR Cold Email Outreach" */
function featureSlugToName(slug: string): string {
  return slug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
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
    const dsHeaders = extractDownstreamHeaders(req);

    traceEvent(runId, {
      service: "workflow-service",
      event: "generate-start",
      detail: `Generating workflow for featureSlug="${body.featureSlug}" description="${body.description.slice(0, 100)}"`,
      data: { featureSlug: body.featureSlug, hasHints: !!body.hints, hasStyle: !!body.style },
    }, req.headers).catch(() => {});

    const generated = await generateWorkflow(
      { description: body.description, hints: body.hints, style: body.style },
      dsHeaders,
    );

    const dag = generated.dag as DAG;
    const signature = computeDAGSignature(generated.dag);

    traceEvent(runId, {
      service: "workflow-service",
      event: "generate-complete",
      detail: `Generated DAG with ${dag.nodes?.length ?? 0} nodes, signature=${signature.slice(0, 12)}, category=${generated.category ?? "none"}`,
      data: { nodeCount: dag.nodes?.length ?? 0, signature: signature.slice(0, 12), category: generated.category },
    }, req.headers).catch(() => {});

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
      workflowSlug: string;
      workflowName: string;
      workflowDynastySlug: string;
      featureSlug: string;
      tags: string[];
      signature: string;
      signatureName: string;
      action: "created" | "updated";
    };

    let result: DeployResult;

    if (existing && existing.signature === signature) {
      const openFlow = dagToOpenFlow(dag, existing.workflowSlug);
      const client = getWindmillClient();
      if (client && existing.windmillFlowPath) {
        try {
          await client.updateFlow(existing.windmillFlowPath, {
            summary: existing.workflowSlug,
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
        workflowSlug: updated.workflowSlug,
        workflowName: updated.workflowName,
        workflowDynastySlug: updated.dynastySlug,
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

      const featureName = featureSlugToName(body.featureSlug);
      const dynastySlug = `${body.featureSlug}-${signatureName}`;
      const dynastyName = `${featureName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
      const newVersion = existing ? existing.version + 1 : 1;
      const workflowSlug = composeSlug(dynastySlug, newVersion);
      const workflowName = composeName(dynastyName, newVersion);

      const openFlow = dagToOpenFlow(dag, workflowSlug);
      const flowPath = generateFlowPath(orgId, workflowSlug);
      const client = getWindmillClient();

      if (client) {
        try {
          await client.createFlow({
            path: flowPath,
            summary: workflowSlug,
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
          workflowSlug,
          workflowName,
          dynastySlug,
          dynastyName,
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
        workflowSlug: created.workflowSlug,
        workflowName: created.workflowName,
        workflowDynastySlug: created.dynastySlug,
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

    const featureName = featureSlugToName(body.featureSlug);
    const dynastySlug = `${body.featureSlug}-${signatureName}`;
    const dynastyName = `${featureName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
    const workflowSlug = dynastySlug; // v1 — no version suffix
    const workflowName = dynastyName;

    // Translate to OpenFlow
    const openFlow = dagToOpenFlow(dag, workflowSlug);
    const flowPath = generateFlowPath(orgId, workflowSlug);

    // Push to Windmill (if configured)
    const client = getWindmillClient();
    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: workflowSlug,
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
        workflowSlug,
        workflowName,
        dynastySlug,
        dynastyName,
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

    const deployRunId = req.headers["x-run-id"] as string | undefined;

    console.log(`[workflow-service] deploy: org=${orgId} workflows=${body.workflows.length}`);

    if (deployRunId) {
      traceEvent(deployRunId, {
        service: "workflow-service",
        event: "deploy-start",
        detail: `Deploying ${body.workflows.length} workflow(s) for org=${orgId}`,
        data: { workflowCount: body.workflows.length, orgId },
      }, req.headers).catch(() => {});
    }

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
          const specs = await fetchSpecsForServices([...allServiceNames], extractDownstreamHeaders(req));
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
        const templates = await fetchPromptTemplates(types, extractDownstreamHeaders(req));

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

    const results: { id: string; workflowSlug: string; workflowName: string; workflowDynastySlug: string; featureSlug: string; tags: string[]; signature: string; signatureName: string; version: number; action: "created" | "updated" | "deprecated-to-existing" }[] = [];

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
          `[workflow-service] deploy: sig=${signature.slice(0, 12)} matched "${activeForFeature.workflowSlug}" (${activeForFeature.id}) -> update`,
        );
        const openFlow = dagToOpenFlow(dag, activeForFeature.workflowSlug);
        const client = getWindmillClient();

        if (client && activeForFeature.windmillFlowPath) {
          try {
            await client.updateFlow(activeForFeature.windmillFlowPath, {
              summary: activeForFeature.workflowSlug,
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
          workflowSlug: updated.workflowSlug,
          workflowName: updated.workflowName,
          workflowDynastySlug: updated.dynastySlug,
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
            `[workflow-service] deploy: convergence — "${activeForFeature.workflowSlug}" -> existing "${convergenceTarget.workflowSlug}"`,
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
            workflowSlug: convergenceTarget.workflowSlug,
            workflowName: convergenceTarget.workflowName,
            workflowDynastySlug: convergenceTarget.dynastySlug,
            featureSlug: convergenceTarget.featureSlug,
            tags: (convergenceTarget.tags as string[]) ?? [],
            signature: convergenceTarget.signature,
            signatureName: convergenceTarget.signatureName,
            version: convergenceTarget.version,
            action: "deprecated-to-existing",
          });
        } else {
          // Upgrade: deprecate old, create new version in the same lineage
          const newVersion = activeForFeature.version + 1;
          const signatureName = activeForFeature.signatureName;
          const dynastySlug = activeForFeature.dynastySlug;
          const dynastyName = activeForFeature.dynastyName;
          const newSlug = composeSlug(dynastySlug, newVersion);
          const newName = composeName(dynastyName, newVersion);

          console.log(
            `[workflow-service] deploy: sig=${signature.slice(0, 12)} upgrade "${activeForFeature.workflowSlug}" -> "${newSlug}" (v${newVersion})`,
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
              workflowSlug: newSlug,
              workflowName: newName,
              dynastySlug,
              dynastyName,
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
            workflowSlug: created.workflowSlug,
            workflowName: created.workflowName,
            workflowDynastySlug: created.dynastySlug,
            featureSlug: created.featureSlug,
            tags: (created.tags as string[]) ?? [],
            signature: created.signature,
            signatureName: created.signatureName,
            version: created.version,
            action: "created",
          });
        }
      } else {
        // No active workflow for this featureSlug — new lineage
        const signatureName = pickSignatureName(signature, usedNames);
        usedNames.add(signatureName);

        const featureName = featureSlugToName(wf.featureSlug);
        const dynastySlug = `${wf.featureSlug}-${signatureName}`;
        const dynastyName = `${featureName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
        const workflowSlug = dynastySlug; // v1 has no version suffix
        const workflowName = dynastyName;

        console.log(
          `[workflow-service] deploy: sig=${signature.slice(0, 12)} new dynasty -> "${workflowSlug}"`,
        );

        const openFlow = dagToOpenFlow(dag, workflowSlug);
        const flowPath = generateFlowPath(orgId, workflowSlug);
        const client = getWindmillClient();

        if (client) {
          try {
            await client.createFlow({
              path: flowPath,
              summary: workflowSlug,
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
            workflowSlug,
            workflowName,
            dynastySlug,
            dynastyName,
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
          workflowSlug: created.workflowSlug,
          workflowName: created.workflowName,
          workflowDynastySlug: created.dynastySlug,
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

    if (deployRunId) {
      traceEvent(deployRunId, {
        service: "workflow-service",
        event: "deploy-complete",
        detail: `Deploy complete: total=${results.length} created=${createdCount} updated=${updatedCount} slugs=[${results.map(r => r.workflowSlug).join(",")}]`,
        data: { total: results.length, created: createdCount, updated: updatedCount, slugs: results.map(r => r.workflowSlug) },
      }, req.headers).catch(() => {});
    }

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

// GET /workflows/dynasties — List all dynasties with their versioned workflow slugs
router.get("/workflows/dynasties", requireApiKey, async (req, res) => {
  try {
    const allWorkflows = await db
      .select({ workflowSlug: workflows.workflowSlug, dynastySlug: workflows.dynastySlug, dynastyName: workflows.dynastyName })
      .from(workflows);

    const dynastyMap = new Map<string, { dynastyName: string; workflowSlugs: string[] }>();
    for (const w of allWorkflows) {
      const entry = dynastyMap.get(w.dynastySlug);
      if (entry) {
        entry.workflowSlugs.push(w.workflowSlug);
      } else {
        dynastyMap.set(w.dynastySlug, { dynastyName: w.dynastyName, workflowSlugs: [w.workflowSlug] });
      }
    }

    const dynasties = [...dynastyMap.entries()].map(([workflowDynastySlug, { dynastyName, workflowSlugs }]) => ({
      workflowDynastySlug,
      workflowDynastyName: dynastyName,
      workflowSlugs,
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
    const dynastySlug = req.query.workflowDynastySlug ?? req.query.dynastySlug;
    if (!dynastySlug || typeof dynastySlug !== "string") {
      res.status(400).json({ error: "Missing required query parameter: workflowDynastySlug" });
      return;
    }

    const matching = await db
      .select({ workflowSlug: workflows.workflowSlug, dynastyName: workflows.dynastyName })
      .from(workflows)
      .where(eq(workflows.dynastySlug, dynastySlug));

    if (matching.length === 0) {
      res.status(404).json({ error: `No workflows found for workflowDynastySlug: ${dynastySlug}` });
      return;
    }

    res.json({
      workflowDynastySlug: dynastySlug,
      workflowDynastyName: matching[0].dynastyName,
      workflowSlugs: matching.map((w) => w.workflowSlug),
    });
  } catch (err) {
    console.error("[workflow-service] GET dynasty/slugs error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /workflows/dynasty/stats — Aggregated stats for a dynasty (full upgrade chain)
router.get("/workflows/dynasty/stats", requireApiKey, async (req, res) => {
  try {
    const dynastySlug = req.query.workflowDynastySlug ?? req.query.dynastySlug;
    if (!dynastySlug || typeof dynastySlug !== "string") {
      res.status(400).json({ error: "Missing required query parameter: workflowDynastySlug" });
      return;
    }

    const objectiveParam = req.query.objective;
    if (!objectiveParam || typeof objectiveParam !== "string") {
      res.status(400).json({ error: "Missing required query parameter: objective (stats key, e.g. 'emailsReplied')" });
      return;
    }
    const objective = objectiveParam;

    const dsHeaders = extractDownstreamHeaders(req);

    const allDynastyWorkflows = await db
      .select()
      .from(workflows)
      .where(eq(workflows.dynastySlug, dynastySlug));

    if (allDynastyWorkflows.length === 0) {
      res.status(404).json({ error: `No workflows found for workflowDynastySlug: ${dynastySlug}` });
      return;
    }

    const activeWorkflows = allDynastyWorkflows.filter((w) => w.status === "active");
    const deprecatedWorkflows = allDynastyWorkflows.filter((w) => w.status === "deprecated");

    if (activeWorkflows.length === 0) {
      res.json({
        workflowDynastySlug: dynastySlug,
        workflowDynastyName: allDynastyWorkflows[0].dynastyName,
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

    const { scores } = await computeWorkflowScores(activeWorkflows, deprecatedWorkflows, objective, { kind: "auth", downstreamHeaders: dsHeaders });

    const stats = aggregateSectionStats(scores);

    res.json({
      workflowDynastySlug: dynastySlug,
      workflowDynastyName: allDynastyWorkflows[0].dynastyName,
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
    const { orgId, brandId, humanId, campaignId, featureSlug, workflowSlug, workflowDynastySlug, tag, status } = req.query;

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
    if (workflowSlug && typeof workflowSlug === "string") {
      conditions.push(eq(workflows.workflowSlug, workflowSlug));
    }
    if (workflowDynastySlug && typeof workflowDynastySlug === "string") {
      conditions.push(eq(workflows.dynastySlug, workflowDynastySlug));
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
    const dsHeaders = extractDownstreamHeaders(req);

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

    const result = await fetchProviderRequirements(endpoints, dsHeaders);

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

      const openFlow = dagToOpenFlow(dag, existing.workflowSlug);
      if (existing.windmillFlowPath) {
        const client = getWindmillClient();
        if (client) {
          try {
            await client.updateFlow(existing.windmillFlowPath, {
              summary: existing.workflowSlug,
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
      .select({ id: workflows.id, workflowSlug: workflows.workflowSlug })
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
        existingWorkflowSlug: conflicting.workflowSlug,
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

    const featureName = featureSlugToName(existing.featureSlug);
    const newDynastySlug = `${existing.featureSlug}-${signatureName}`;
    const newDynastyName = `${featureName} ${signatureName.charAt(0).toUpperCase() + signatureName.slice(1)}`;
    const newWorkflowSlug = newDynastySlug; // v1 has no version suffix
    const newWorkflowName = newDynastyName;

    const openFlow = dagToOpenFlow(dag, newWorkflowSlug);
    const flowPath = generateFlowPath(orgId, newWorkflowSlug);
    const client = getWindmillClient();

    if (client) {
      try {
        await client.createFlow({
          path: flowPath,
          summary: newWorkflowSlug,
          description: body.description ?? existing.description ?? undefined,
          value: openFlow.value,
          schema: openFlow.schema,
        });
      } catch (err) {
        if (err instanceof Error && err.message.includes("already exists")) {
          try {
            await client.updateFlow(flowPath, {
              summary: newWorkflowSlug,
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
          workflowSlug: newWorkflowSlug,
          workflowName: newWorkflowName,
          dynastySlug: newDynastySlug,
          dynastyName: newDynastyName,
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
      .where(
        and(
          eq(workflows.featureSlug, existing.featureSlug),
          eq(workflows.signatureName, existing.signatureName),
        )
      );
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
          `[workflow-service] fork+deprecate: "${existing.workflowSlug}" (${existing.id}) -> "${newWorkflowSlug}" (${forked.id}) [dynasty had 0 campaign runs]`,
        );
      } else {
        console.log(
          `[workflow-service] fork: "${existing.workflowSlug}" (${existing.id}) -> "${newWorkflowSlug}" (${forked.id}) [source dynasty kept active: ${campaignRuns.length} campaign run(s)]`,
        );
      }
    }

    res.status(201).json({
      ...formatWorkflow(forked),
      _action: "forked" as const,
      _forkedFromWorkflowName: existing.workflowName,
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
        const templates = await fetchPromptTemplates(types, extractDownstreamHeaders(req));
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
