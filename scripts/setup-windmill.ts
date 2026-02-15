import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { WindmillClient } from "../src/lib/windmill-client.js";
import { NODE_TYPE_REGISTRY } from "../src/lib/node-type-registry.js";

const NODES_DIR = join(import.meta.dirname ?? ".", "nodes");

async function main() {
  const baseUrl = process.env.WINDMILL_SERVER_URL;
  const token = process.env.WINDMILL_SERVER_API_KEY;
  const workspace = process.env.WINDMILL_SERVER_WORKSPACE ?? "prod";

  if (!baseUrl || !token) {
    console.error("WINDMILL_SERVER_URL and WINDMILL_SERVER_API_KEY are required");
    process.exit(1);
  }

  const client = new WindmillClient({ baseUrl, token, workspace });

  const nodeFiles = readdirSync(NODES_DIR).filter((f) => f.endsWith(".ts"));
  console.log(`Found ${nodeFiles.length} node scripts to deploy`);

  for (const file of nodeFiles) {
    const nodeType = basename(file, ".ts");
    const scriptPath =
      NODE_TYPE_REGISTRY[nodeType] ?? `f/nodes/${nodeType.replace(/-/g, "_")}`;

    if (!scriptPath) {
      console.log(`  Skipping ${nodeType} (native Windmill construct)`);
      continue;
    }

    const content = readFileSync(join(NODES_DIR, file), "utf-8");

    try {
      await client.createScript({
        path: scriptPath,
        summary: `Node: ${nodeType}`,
        description: `Auto-deployed node script for type "${nodeType}"`,
        content,
        language: "bun",
      });
      console.log(`  Deployed ${nodeType} → ${scriptPath}`);
    } catch (err) {
      console.error(`  Failed to deploy ${nodeType}:`, err);
    }
  }

  console.log("Done!");
}

main();
