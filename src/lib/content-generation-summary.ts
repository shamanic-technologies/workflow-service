import type { DAG } from "./dag-validator.js";

/**
 * The two facts a workflow list row wants to display: which chat-service model
 * alias the workflow writes its content with, and which content-generation
 * prompt template it renders.
 *
 * Both live inside the DAG, on the `content-generation POST /generate` node's
 * request body. Deriving them here — once, at read, by the owner of "which node
 * is the content call" — is what keeps a consumer from downloading N DAGs and
 * reimplementing that rule to render two words per row.
 */
export interface ContentGenerationSummary {
  contentModel: string | null;
  contentPromptType: string | null;
}

/**
 * Reads a literal request-body value off a `/generate` node.
 *
 * Two spellings carry it and both are in use: an `inputMapping["body.<field>"]`
 * entry (which overrides the static base) and a plain `config.body.<field>`.
 * A `$ref:` mapping is a value produced by another node at RUN time and is
 * therefore unknowable here — it yields null rather than the static base it
 * overrides, because the base is not what the run would use.
 */
function literalBodyValue(
  node: DAG["nodes"][number],
  field: string,
): string | null {
  const mapped = node.inputMapping?.[`body.${field}`];
  if (typeof mapped === "string") {
    return mapped.startsWith("$ref:") ? null : mapped;
  }

  const body = node.config?.body as Record<string, unknown> | undefined;
  if (typeof body?.[field] === "string") {
    return body[field] as string;
  }

  return null;
}

/**
 * Collapses the values a set of nodes state for one field.
 *
 * A DAG with no content call, or one whose content call does not state the
 * field, yields null. So does a DAG whose several content calls DISAGREE:
 * picking one of them would be a guess about which row the dashboard is meant
 * to label, and the contract says null rather than a guess.
 */
function collapse(values: Array<string | null>): string | null {
  const distinct = new Set(values.filter((v): v is string => v !== null));
  return distinct.size === 1 ? [...distinct][0] : null;
}

export function summarizeContentGeneration(dag: DAG | null | undefined): ContentGenerationSummary {
  const nodes = (dag?.nodes ?? []).filter(
    (n) =>
      n.type === "http.call" &&
      n.config?.service === "content-generation" &&
      n.config?.path === "/generate",
  );

  return {
    contentModel: collapse(nodes.map((n) => literalBodyValue(n, "model"))),
    contentPromptType: collapse(nodes.map((n) => literalBodyValue(n, "type"))),
  };
}
