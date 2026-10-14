import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";

describe("JSON body limit", () => {
  it("is set explicitly and holds the largest DAG this repo builds (a 413 refused the offer-document upgrade)", () => {
    const src = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
    const match = src.match(/express\.json\(\{\s*limit:\s*"(\d+)mb"\s*\}\)/);
    expect(match).not.toBeNull();
    const limitBytes = Number(match![1]) * 1024 * 1024;
    const dag = buildOfferDocumentReplyDag({ provider: "anthropic", model: "opus", omitTemperature: true });
    const body = JSON.stringify({ workflowDynastySlug: "x", dag, description: "x" });
    expect(body.length).toBeGreaterThan(100 * 1024);
    expect(body.length * 4).toBeLessThan(limitBytes);
  });
});
