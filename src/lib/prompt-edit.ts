import type { DAG } from "./dag-validator.js";

/**
 * Pure helpers behind the prompt-edit routes (`POST /workflows/{id}/prompt-edit`
 * and its dynasty twin): what a prompt edit may change, and how the DAG is
 * repointed at the edited template.
 *
 * A content-generation template is shared platform-wide by TYPE, so an edit is
 * never written onto the existing type — it becomes a new type, and only the
 * upgraded or forked workflow is repointed at it. Everything else that renders
 * the old type keeps rendering the old text.
 */

/**
 * The `{{token}}` names a template body states, in first-seen order. Same
 * pattern content-generation's renderer substitutes (`\{\{(\w+)\}\}`), so a
 * token this misses is a token that service would not substitute either.
 */
export function promptVariableNames(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(/\{\{(\w+)\}\}/g)) seen.add(m[1]);
  return [...seen];
}

export interface PromptVariableContractBreak {
  error: string;
  droppedVariables: string[];
  addedVariables: string[];
  requiredVariables: string[];
}

/**
 * An edit may reword anything except the set of `{{variables}}`. Dropping one
 * leaves the workflow feeding a value the prompt no longer prints; adding one
 * asks for a value no node provides, which renders empty at send time with no
 * error. Either is refused here, before anything is written, with a sentence
 * the dashboard can show as-is.
 */
export function checkPromptVariableContract(
  sourcePrompt: string,
  editedPrompt: string,
): PromptVariableContractBreak | null {
  const required = promptVariableNames(sourcePrompt);
  const edited = new Set(promptVariableNames(editedPrompt));
  const requiredSet = new Set(required);

  const dropped = required.filter((v) => !edited.has(v));
  const added = [...edited].filter((v) => !requiredSet.has(v));
  if (dropped.length === 0 && added.length === 0) return null;

  const parts: string[] = [];
  if (dropped.length > 0) {
    parts.push(`removes ${dropped.map((v) => `{{${v}}}`).join(", ")}`);
  }
  if (added.length > 0) {
    parts.push(`adds ${added.map((v) => `{{${v}}}`).join(", ")}, which this workflow does not provide`);
  }
  return {
    error:
      `The edited prompt ${parts.join(" and ")}. ` +
      `An edited prompt must keep exactly the variables of the one it replaces: ` +
      `${required.map((v) => `{{${v}}}`).join(", ") || "(none)"}.`,
    droppedVariables: dropped,
    addedVariables: added,
    requiredVariables: required,
  };
}

function isGenerateNode(node: DAG["nodes"][number]): boolean {
  return (
    node.type === "http.call" &&
    node.config?.service === "content-generation" &&
    node.config?.path === "/generate"
  );
}

/**
 * Returns a copy of `dag` whose content-generation call(s) render `toType`
 * instead of `fromType`. Both spellings of a literal type are repointed (an
 * `inputMapping["body.type"]` literal, which overrides the static base, and a
 * plain `config.body.type`). Throws when nothing named `fromType` — the caller
 * resolved `fromType` from this same DAG, so that is a broken invariant.
 */
export function repointPromptTemplate(dag: DAG, fromType: string, toType: string): DAG {
  const clone = structuredClone(dag);
  let repointed = 0;

  for (const node of clone.nodes) {
    if (!isGenerateNode(node)) continue;

    if (node.inputMapping?.["body.type"] === fromType) {
      node.inputMapping["body.type"] = toType;
      repointed++;
    }
    const body = node.config?.body as Record<string, unknown> | undefined;
    if (body?.type === fromType) {
      body.type = toType;
      repointed++;
    }
  }

  if (repointed === 0) {
    throw new Error(`no content-generation call in this DAG renders template "${fromType}"`);
  }
  return clone;
}
