import type { DAG } from "./dag-validator.js";
import type { PromptTemplate } from "./content-generation-client.js";

export interface TemplateRef {
  nodeId: string;
  templateType: string;
  variablesProvided: string[];
}

export interface TemplateContractIssue {
  nodeId: string;
  templateType: string;
  field: string;
  severity: "error" | "warning";
  reason: string;
}

export interface TemplateContractResult {
  valid: boolean;
  templateRefs: TemplateRef[];
  issues: TemplateContractIssue[];
}

/**
 * Extracts content-generation template references from a DAG.
 *
 * Detects http.call nodes with config.service = "content-generation" and config.path = "/generate".
 */
export function extractTemplateRefs(dag: DAG): TemplateRef[] {
  const refs: TemplateRef[] = [];

  for (const node of dag.nodes) {
    const isHttpCallToContentGen =
      node.type === "http.call" &&
      node.config?.service === "content-generation" &&
      node.config?.path === "/generate";

    if (!isHttpCallToContentGen) continue;

    // Extract template type from inputMapping["body.type"] or config.body.type
    let templateType: string | undefined;

    if (node.inputMapping?.["body.type"]) {
      const val = node.inputMapping["body.type"];
      // Only use literal values, not $ref
      if (!val.startsWith("$ref:")) {
        templateType = val;
      }
    }

    if (!templateType) {
      const body = node.config?.body as Record<string, unknown> | undefined;
      if (typeof body?.type === "string") {
        templateType = body.type;
      }
    }

    if (!templateType) continue;

    // Extract variables provided via body.variables.* keys
    const variablesProvided: string[] = [];
    if (node.inputMapping) {
      for (const key of Object.keys(node.inputMapping)) {
        const match = key.match(/^body\.variables\.(.+)$/);
        if (match) {
          variablesProvided.push(match[1]);
        }
      }
    }

    refs.push({ nodeId: node.id, templateType, variablesProvided });
  }

  return refs;
}

/**
 * Validates that the variables a workflow provides to content-generation nodes
 * match the variables declared in the corresponding prompt templates.
 *
 * Pure function — no I/O. Call fetchPromptTemplates() separately.
 */
export function validateTemplateContracts(
  dag: DAG,
  templates: Map<string, PromptTemplate>,
): TemplateContractResult {
  const templateRefs = extractTemplateRefs(dag);
  const issues: TemplateContractIssue[] = [];

  for (const ref of templateRefs) {
    const template = templates.get(ref.templateType);

    if (!template) {
      issues.push({
        nodeId: ref.nodeId,
        templateType: ref.templateType,
        field: ref.templateType,
        severity: "warning",
        reason: `Template "${ref.templateType}" not found in content-generation service — cannot validate variable contract`,
      });
      continue;
    }

    const declaredVars = new Set(template.variables);
    const providedVars = new Set(ref.variablesProvided);

    // Missing variables (declared in template but not provided by workflow) → error
    for (const declared of declaredVars) {
      if (!providedVars.has(declared)) {
        issues.push({
          nodeId: ref.nodeId,
          templateType: ref.templateType,
          field: declared,
          severity: "error",
          reason: `Template "${ref.templateType}" expects variable "${declared}" but node "${ref.nodeId}" does not provide it. Available variables from this node: ${ref.variablesProvided.join(", ") || "(none)"}`,
        });
      }
    }

    // Extra variables (provided by workflow but not declared in template) → warning
    for (const provided of providedVars) {
      if (!declaredVars.has(provided)) {
        issues.push({
          nodeId: ref.nodeId,
          templateType: ref.templateType,
          field: provided,
          severity: "warning",
          reason: `Node "${ref.nodeId}" provides variable "${provided}" but template "${ref.templateType}" does not declare it — this variable will be ignored. Declared variables: ${template.variables.join(", ")}`,
        });
      }
    }
  }

  const hasErrors = issues.some((i) => i.severity === "error");

  return { valid: !hasErrors, templateRefs, issues };
}
