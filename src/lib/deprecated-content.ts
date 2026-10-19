import type { DAG } from "./dag-validator.js";
import { literalBodyValue } from "./content-generation-summary.js";
import { fetchModelStatuses, fetchPromptTemplate } from "./content-generation-client.js";
import type { DownstreamHeaders } from "./downstream-headers.js";

// TEMPLATE-MODEL-STATUS-1019 (owner 2026-10-19): a template or a writer model staff DEPRECATED may not come back
// through a new workflow, an upgrade or a fork. content-generation owns the status; this is the write-time
// refusal. Stored workflows keep generating (content-generation never reads a status at /generate); the ones
// using it were retired by POST /workflows/retire-by-content.

export interface DeprecatedContentIssue {
  nodeId: string;
  field: "body.type" | "body.model";
  value: string;
  reason: string;
}

/** Every literal template type / model alias a content-generation `/generate` node states. */
export function contentRefsOf(dag: DAG): Array<{ nodeId: string; promptType: string | null; model: string | null }> {
  return dag.nodes
    .filter((n) => n.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate")
    .map((n) => ({ nodeId: n.id, promptType: literalBodyValue(n, "type"), model: literalBodyValue(n, "model") }));
}

/**
 * The deprecated templates / models this DAG names. Reads content-generation's catalogue; when that read
 * fails the check is skipped and logged (same boundary as the endpoint check: a blip never blocks every write).
 */
export async function findDeprecatedContent(dag: DAG, downstreamHeaders?: DownstreamHeaders): Promise<DeprecatedContentIssue[]> {
  const refs = contentRefsOf(dag);
  if (refs.length === 0) return [];
  const issues: DeprecatedContentIssue[] = [];
  try {
    const types = [...new Set(refs.map((r) => r.promptType).filter((t): t is string => t !== null))];
    const deprecatedTypes = new Set<string>();
    for (const type of types) {
      const template = await fetchPromptTemplate(type, downstreamHeaders);
      if (template?.status === "deprecated") deprecatedTypes.add(type);
    }
    const models = refs.some((r) => r.model !== null) ? await fetchModelStatuses() : new Map<string, string>();
    for (const r of refs) {
      if (r.promptType && deprecatedTypes.has(r.promptType)) {
        issues.push({ nodeId: r.nodeId, field: "body.type", value: r.promptType, reason: `Template "${r.promptType}" is deprecated: pick an active template` });
      }
      if (r.model && models.get(r.model) === "deprecated") {
        issues.push({ nodeId: r.nodeId, field: "body.model", value: r.model, reason: `Model "${r.model}" is deprecated: pick an active model` });
      }
    }
  } catch (err) {
    console.warn("[workflow-service] deprecated template/model check skipped (content-generation unreadable):", err instanceof Error ? err.message : err);
    return [];
  }
  return issues;
}
