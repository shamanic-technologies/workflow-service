#!/usr/bin/env node
/**
 * Prints the Threads posts workflow (THREADS-CAMPAIGN-1028, `src/lib/threads-post-dag.ts`) as the JSON body the
 * distribute MCP sends: `node scripts/print-threads-post-dag.mjs create` (POST /v1/workflows, on the pipe) or
 * `... upgrade <workflowDynastySlug>` (POST /v1/workflows/upgrade). The workflow is created and upgraded through the
 * MCP like any client's (mcp-first), never by a seed calling this service directly. Needs `npm run build` first.
 */
import { buildThreadsPostDag, THREADS_POST_DESCRIPTION, THREADS_POST_FEATURE_SLUG, THREADS_POST_PIPE_ID } from "../dist/lib/threads-post-dag.js";

const [mode = "create", dynasty] = process.argv.slice(2);
const dag = buildThreadsPostDag();
if (mode === "upgrade") {
  if (!dynasty) throw new Error("upgrade needs the workflowDynastySlug");
  console.log(JSON.stringify({ workflowDynastySlug: dynasty, dag, description: THREADS_POST_DESCRIPTION }));
} else {
  console.log(JSON.stringify({ featureSlug: THREADS_POST_FEATURE_SLUG, pipeId: THREADS_POST_PIPE_ID, description: THREADS_POST_DESCRIPTION, dag }));
}
