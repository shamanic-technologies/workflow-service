import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Every outbound fetch in this repo must carry an AbortSignal with a >=10min
 * deadline. Bun's default fetch idle timeout (~5min) kills the connection
 * mid-flight for long-running downstreams (RAG ranking, heavy enrichment),
 * which surfaces as `TimeoutError` step failures in Windmill flows.
 */

const TIMEOUT_LITERAL = "AbortSignal.timeout(600_000)";

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listTsFiles(join(dir, entry.name)));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

function countOutboundFetchCalls(source: string): number {
  // Count `fetch(` occurrences that are outbound HTTP calls (excluding
  // res.text/json and method declarations). Whitespace-tolerant.
  const matches = source.match(/(^|\s|=|\()fetch\(/g);
  return matches ? matches.length : 0;
}

function countTimeoutMarkers(source: string): number {
  return source.split(TIMEOUT_LITERAL).length - 1;
}

describe("fetch-timeout audit", () => {
  const targets = [
    ...listTsFiles(join(REPO_ROOT, "scripts", "nodes")),
    ...listTsFiles(join(REPO_ROOT, "src", "lib")),
  ];

  for (const filePath of targets) {
    const source = readFileSync(filePath, "utf8");
    const fetchCount = countOutboundFetchCalls(source);
    if (fetchCount === 0) continue;

    const relPath = filePath.slice(REPO_ROOT.length + 1);
    it(`${relPath} — every fetch has AbortSignal.timeout(600_000)`, () => {
      const timeoutCount = countTimeoutMarkers(source);
      expect(timeoutCount).toBeGreaterThanOrEqual(fetchCount);
    });
  }
});
