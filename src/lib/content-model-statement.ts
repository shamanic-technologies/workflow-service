import type { DAG } from "./dag-validator.js";

/**
 * The model alias content-generation-service applies when a `/generate` request
 * body names none. Read off that service's own `DEFAULT_MODEL` in
 * `src/lib/chat-models.ts` (`export const DEFAULT_MODEL: ChatModel = "pro";`,
 * origin/main, 2026-09-11) — it is stated here as the value a one-time backfill
 * WRITES INTO the DAGs, never as a read-time fallback: a DAG that names no model
 * keeps serving `contentModel: null`, because the contract is "the call names
 * none" and a consumer must not fabricate another service's default.
 */
export const CONTENT_GENERATION_DEFAULT_MODEL = "pro";

/** The request-body field the content call names its model in. */
export const MODEL_BODY_FIELD = "model";

export type ModelStatementPlan =
  | { nodeId: string; action: "add"; model: string }
  | { nodeId: string; action: "already-stated"; model: string }
  | { nodeId: string; action: "skip"; reason: string };

function isGenerateNode(node: DAG["nodes"][number]): boolean {
  return (
    node.type === "http.call" &&
    node.config?.service === "content-generation" &&
    node.config?.path === "/generate"
  );
}

/**
 * States the model a content call already runs on, on every `/generate` node of
 * a DAG that names none.
 *
 * Three shapes are left untouched, and each for its own reason:
 *  - a node whose body already names a model — it runs on that one;
 *  - a node whose `inputMapping["body.model"]` is a `$ref:` — the model is
 *    chosen by another node at run time, so no literal is true of it;
 *  - a node whose `inputMapping["body"]` replaces the whole body — anything
 *    written into `config.body` would never be sent.
 */
export function applyStatedContentModel(
  dag: DAG,
  model: string = CONTENT_GENERATION_DEFAULT_MODEL,
): { dag: DAG; plans: ModelStatementPlan[]; changed: boolean } {
  const next = structuredClone(dag);
  const plans: ModelStatementPlan[] = [];
  let changed = false;

  for (const node of next.nodes) {
    if (!isGenerateNode(node)) continue;

    const mapped = node.inputMapping?.[`body.${MODEL_BODY_FIELD}`];
    if (typeof mapped === "string") {
      plans.push(
        mapped.startsWith("$ref:")
          ? { nodeId: node.id, action: "skip", reason: `body.${MODEL_BODY_FIELD} is produced at run time (${mapped})` }
          : { nodeId: node.id, action: "already-stated", model: mapped },
      );
      continue;
    }

    if (node.inputMapping?.body !== undefined) {
      plans.push({
        nodeId: node.id,
        action: "skip",
        reason: "the whole request body is supplied by inputMapping.body",
      });
      continue;
    }

    const body = (node.config?.body ?? {}) as Record<string, unknown>;
    if (typeof body[MODEL_BODY_FIELD] === "string") {
      plans.push({ nodeId: node.id, action: "already-stated", model: body[MODEL_BODY_FIELD] as string });
      continue;
    }
    if (body[MODEL_BODY_FIELD] !== undefined) {
      plans.push({
        nodeId: node.id,
        action: "skip",
        reason: `body.${MODEL_BODY_FIELD} is present but not a string`,
      });
      continue;
    }

    node.config = { ...(node.config ?? {}), body: { ...body, [MODEL_BODY_FIELD]: model } };
    plans.push({ nodeId: node.id, action: "add", model });
    changed = true;
  }

  return { dag: next, plans, changed };
}

/** True when every `/generate` node of the DAG names a literal model. */
export function statesContentModel(dag: DAG): boolean {
  const { plans } = applyStatedContentModel(dag);
  return plans.length > 0 && plans.every((p) => p.action === "already-stated");
}
