import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { AgentTurnRequestSchema } from "../schemas.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { chatServiceComplete, type ChatServiceCompleteRequest } from "../lib/chat-service-client.js";
import { productionDeps } from "../lib/figure-reader.js";
import { runAgentTurn } from "../lib/agent-turn.js";

const router = Router();

/**
 * POST /orgs/agent/turns — one writer turn with tools (SOPHIE-LEAD-EVENT-AGENT-1027): the caller's prompt is the
 * context, the model reads the RECIPIENT's own account through tools before it answers in the caller's schema. Any
 * workflow calls it as an `http.call` node in place of chat-service `/complete`. See `src/lib/agent-turn.ts`.
 */
router.post("/orgs/agent/turns", requireApiKey, async (req, res) => {
  const parsed = AgentTurnRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: parsed.error.flatten() });
    return;
  }
  const headers = extractDownstreamHeaders(req);
  const complete = (request: Record<string, unknown>) => chatServiceComplete(request as unknown as ChatServiceCompleteRequest, headers);
  try {
    const result = await runAgentTurn(
      { ...parsed.data, recipientEmail: parsed.data.recipientEmail ?? null },
      { ...productionDeps(headers, (request) => complete(request)), complete },
    );
    console.log(
      `[workflow-service] agent turn run=${res.locals.runId} model=${parsed.data.provider}/${parsed.data.model} ` +
      `recipient=${result.recipient.email ?? "none"} orgs=${result.recipient.organizations.length} steps=${result.steps.length} ` +
      `reads=${result.reads.length} refused=${result.reads.filter((r) => r.refused).length}`,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[workflow-service] agent turn failed: ${message}`);
    res.status(502).json({ error: message });
  }
});

export default router;
