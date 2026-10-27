/**
 * Turns a chat writer's `/complete` call into an AGENT TURN (`POST /orgs/agent/turns` on this service,
 * SOPHIE-LEAD-EVENT-AGENT-1027): same prompt, same answer schema, same model mappings (the leg's best LLM), plus the
 * recipient whose own account the turn may read through tools. Applied LAST, after the voice and the LLM pick were
 * spliced onto the `/complete` call, so both read it exactly as before. The answer comes back as `json`, like
 * `/complete`, so the node after it is unchanged.
 */
import type { DAG } from "./dag-validator.js";

export const AGENT_TURN_CALL = { service: "workflow", method: "POST", path: "/orgs/agent/turns" } as const;

/** The `/complete` body keys an agent turn does not take (it always answers in JSON). */
const NOT_AGENT_KEYS = new Set(["responseFormat", "temperature"]);

export function withAgentTurn(dag: DAG, nodeId: string, recipientEmailRef: string): DAG {
  const node = dag.nodes.find((n) => n.id === nodeId);
  if (!node || node.type !== "http.call" || node.config?.service !== "chat" || node.config?.path !== "/complete") {
    throw new Error(`withAgentTurn: "${nodeId}" is not a chat-service /complete call`);
  }
  const body = Object.fromEntries(
    Object.entries((node.config?.body as Record<string, unknown> | undefined) ?? {}).filter(([k]) => !NOT_AGENT_KEYS.has(k)),
  );
  return {
    ...dag,
    nodes: dag.nodes.map((n) =>
      n.id === nodeId
        ? {
            ...n,
            config: { ...n.config, ...AGENT_TURN_CALL, body },
            inputMapping: { ...n.inputMapping, "body.recipientEmail": recipientEmailRef },
          }
        : n,
    ),
  };
}

/** True when `nodeId` runs as an agent turn. */
export function isAgentTurn(dag: { nodes?: Array<{ id?: string; config?: Record<string, unknown> }> } | null | undefined, nodeId: string): boolean {
  const n = (dag?.nodes ?? []).find((x) => x.id === nodeId);
  return !!n && n.config?.service === AGENT_TURN_CALL.service && n.config?.path === AGENT_TURN_CALL.path;
}
