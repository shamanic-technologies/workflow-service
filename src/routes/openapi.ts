import { Router } from "express";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const router = Router();
const __dirname = dirname(fileURLToPath(import.meta.url));

router.get("/openapi.json", (_req, res) => {
  try {
    const specPath = join(__dirname, "../../openapi.json");
    const spec = readFileSync(specPath, "utf-8");
    res.json(JSON.parse(spec));
  } catch {
    res.status(404).json({ error: "OpenAPI spec not found" });
  }
});

export default router;
