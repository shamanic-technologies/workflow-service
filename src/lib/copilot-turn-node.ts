/**
 * THE WRITER IS THE COPILOT (ONE-AI-CONVERSES-1029). Owner Kevin, 2026-10-29: « ON VEUT UNE PUTAIN D'IA QUI CONVERSE
 * AVEC LES LEADS ET LES CLIENTS AU BON MOMENT ET DE LA BONNE FAÇON [...] S'IL RÉPOND IL DOIT AVOIR ACCÈS AUX INFOS SOIT
 * EN CONTEXTE SOIT EN MODE AGENTIC TOOL ».
 *
 * One AI answers people: the same Copilot ("Sophie") that answers on the web and on the brand's assistant WhatsApp
 * line writes every Lead event answer. A writer's chat-service `/complete` call becomes chat-service
 * `POST /internal/copilot/lead-turns`: the prompt the writer composed (`systemPrompt` = the game, `message` = thread,
 * who they are, our facts) is the Copilot's CONTEXT; the Copilot keeps its own prompt, skills (our client-comms voice
 * included), tools, sign-in by email code and model, reads the person's own account when they have one, and answers in
 * the writer's `responseSchema`. The answer comes back as `json`, like `/complete`, so the node after it is unchanged.
 *
 * What the turn needs beside the prompt is built by ONE script node (`copilot-turn-plan`) from facts the DAG already
 * holds: the medium the channel plan chose, the person (email, phone, name), the persona of the sending line, the
 * answer field holding the text sent to the person (per medium), and an idempotency key naming the occurrence (one
 * answer per occurrence: a redelivered occurrence gets the stored answer, never a second one). No provider or model is
 * sent: the Copilot runs its own (one AI), so no leg LLM pick is spliced on this call.
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const COPILOT_TURN_CALL = { service: "chat", method: "POST", path: "/internal/copilot/lead-turns" } as const;

/** The `/complete` body keys the Copilot turn does not take: it runs its own model and always answers in JSON. */
const NOT_COPILOT_KEYS = new Set(["provider", "model", "responseFormat", "temperature", "maxTokens"]);

/**
 * `main(person, channel)`: the turn's identity block. `person` = the resolved person (`resolve-person`), `channel` =
 * the channel plan (`whatsapp` | `email`, the persona of the sending line when WhatsApp). The text field per medium is
 * the writer schema's own (`message` on WhatsApp, `bodyHtml` on email).
 */
export const COPILOT_TURN_PLAN_CODE = `
export async function main(person, channel) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const medium = channel?.channel === "whatsapp" ? "whatsapp" : channel?.channel === "email" ? "email" : null;
  if (!medium) return { skip: true };
  const lead = person?.lead ?? {};
  const data = lead.data && typeof lead.data === "object" ? lead.data : {};
  const name = [s(lead.firstName) ?? s(data.firstName), s(lead.lastName) ?? s(data.lastName)].filter(Boolean).join(" ") || null;
  const p = channel?.persona && typeof channel.persona === "object" ? channel.persona : null;
  const key = s(person?.sendKey);
  if (!key) throw new Error("copilot-turn-plan: the resolved person carries no send key");
  return {
    skip: false,
    medium,
    recipient: { email: s(channel?.email) ?? s(person?.email), phone: s(channel?.phone) ?? s(person?.phone), name },
    assistant: p && s(p.name) ? { name: s(p.name), role: s(p.role), instructions: s(p.instructions) } : null,
    messageField: medium === "whatsapp" ? "message" : "bodyHtml",
    idempotencyKey: "copilot-lead-turn:" + key,
  };
}
`.trim();

export const COPILOT_TURN_PLAN_NODE_ID = "copilot-turn-plan";

/**
 * Turns `nodeId` (a chat `/complete` writer) into a Copilot lead turn. `refs`: the resolved person, the channel plan,
 * the brand id. The plan node runs right before the writer, on the edge that runs into it.
 */
export function withCopilotTurn(dag: DAG, nodeId: string, refs: { person: string; channel: string; brandId: string }): DAG {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "http.call" || node.config?.service !== "chat" || node.config?.path !== "/complete") {
    throw new Error(`withCopilotTurn: "${nodeId}" is not a chat-service /complete call`);
  }
  const into = dag.edges.filter((e) => e.to === nodeId);
  if (into.length !== 1) throw new Error(`withCopilotTurn: "${nodeId}" must have exactly one incoming edge, has ${into.length}`);
  const body = Object.fromEntries(
    Object.entries((node.config?.body as Record<string, unknown> | undefined) ?? {}).filter(([k]) => !NOT_COPILOT_KEYS.has(k)),
  );
  const plan: DAGNode = {
    id: COPILOT_TURN_PLAN_NODE_ID,
    type: "script",
    config: { code: COPILOT_TURN_PLAN_CODE },
    retries: 0,
    inputMapping: { person: refs.person, channel: refs.channel },
  };
  const P = `$ref:${COPILOT_TURN_PLAN_NODE_ID}.output`;
  return {
    ...dag,
    nodes: [
      ...dag.nodes.map((n) =>
        n.id === nodeId
          ? {
              ...n,
              config: { ...n.config, ...COPILOT_TURN_CALL, body },
              inputMapping: {
                ...n.inputMapping,
                "body.brandId": refs.brandId,
                "body.medium": `${P}.medium`,
                "body.recipient": `${P}.recipient`,
                "body.assistant": `${P}.assistant`,
                "body.messageField": `${P}.messageField`,
                "body.idempotencyKey": `${P}.idempotencyKey`,
              },
            }
          : n,
      ),
      plan,
    ],
    edges: [
      ...dag.edges.filter((e) => e.to !== nodeId),
      { from: into[0].from, to: COPILOT_TURN_PLAN_NODE_ID },
      { from: COPILOT_TURN_PLAN_NODE_ID, to: nodeId },
    ],
  };
}

/** True when `nodeId` runs as a Copilot lead turn. */
export function isCopilotTurn(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined, nodeId: string): boolean {
  const n = (dag?.nodes ?? []).find((x) => x.id === nodeId);
  return !!n && n.config?.service === COPILOT_TURN_CALL.service && n.config?.path === COPILOT_TURN_CALL.path;
}
