import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { ReadFiguresRequestSchema } from "../schemas.js";
import { extractDownstreamHeaders } from "../lib/downstream-headers.js";
import { chatServiceComplete, type ChatServiceCompleteRequest } from "../lib/chat-service-client.js";
import { productionDeps, readFigures } from "../lib/figure-reader.js";

const router = Router();

/**
 * POST /orgs/figures/read — the figures a message needs, read at run time: public ones, and the RECIPIENT's own
 * account figures (never another customer's). Any workflow calls it as an `http.call` node; the model spend is
 * declared by chat-service on the calling run. See `src/lib/figure-reader.ts` for the no-leak property.
 */
router.post("/orgs/figures/read", requireApiKey, async (req, res) => {
  const parsed = ReadFiguresRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Validation error", details: parsed.error.flatten() });
    return;
  }
  const headers = extractDownstreamHeaders(req);
  try {
    const result = await readFigures(
      { question: parsed.data.question, recipientEmail: parsed.data.recipientEmail ?? null },
      productionDeps(headers, (request, h) => chatServiceComplete(request as unknown as ChatServiceCompleteRequest, h)),
    );
    console.log(
      `[workflow-service] figures/read run=${res.locals.runId} recipient=${result.recipient.email ?? "none"} ` +
      `orgs=${result.recipient.organizations.length} reads=${result.reads.length} ` +
      `refused=${result.reads.filter((r) => r.refused).length} figures=${result.figures.length} missing=${JSON.stringify(result.missing)}`,
    );
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[workflow-service] figures/read failed: ${message}`);
    res.status(502).json({ error: message });
  }
});

export default router;
