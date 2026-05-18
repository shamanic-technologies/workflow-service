export type WorkflowErrorStage =
  | "llm"
  | "registry"
  | "config"
  | "windmill"
  | "unknown";

export function classifyWorkflowError(err: unknown): WorkflowErrorStage {
  if (!(err instanceof Error)) return "unknown";
  const msg = err.message;
  if (msg.includes("chat-service error")) return "llm";
  if (msg.includes("api-registry error")) return "registry";
  if (
    msg.includes("CHAT_SERVICE_URL") ||
    msg.includes("CHAT_SERVICE_API_KEY") ||
    msg.includes("API_REGISTRY_SERVICE_URL") ||
    msg.includes("API_REGISTRY_SERVICE_API_KEY")
  ) {
    return "config";
  }
  if (msg.toLowerCase().includes("windmill")) return "windmill";
  return "unknown";
}
