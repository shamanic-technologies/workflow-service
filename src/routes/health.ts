import { Router } from "express";
import { sql } from "../db/index.js";
import { getWindmillClient } from "../lib/windmill-client.js";

const router = Router();

router.get("/health", async (_req, res) => {
  const checks: Record<string, string> = {};

  try {
    await sql`SELECT 1`;
    checks.db = "connected";
  } catch {
    checks.db = "disconnected";
  }

  try {
    const ok = await getWindmillClient().healthCheck();
    checks.windmill = ok ? "connected" : "disconnected";
  } catch {
    checks.windmill = "disconnected";
  }

  const allOk =
    checks.db === "connected" && checks.windmill === "connected";

  res.status(allOk ? 200 : 503).json({
    status: allOk ? "ok" : "degraded",
    service: "windmill-service",
    ...checks,
  });
});

export default router;
