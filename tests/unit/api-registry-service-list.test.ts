import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchServiceList } from "../../src/lib/api-registry-client.js";

/**
 * ENGINE-GET-ASK-1123 regression: the registry answers `{services: [{name, ...}]}`. `fetchServiceList` typed it as a
 * bare array, so the Provider index (its first caller to READ the answer) threw `.map is not a function` in prod.
 */
describe("fetchServiceList", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.API_REGISTRY_SERVICE_URL = "http://registry.test";
    process.env.API_REGISTRY_SERVICE_API_KEY = "k";
  });
  afterEach(() => {
    process.env = { ...env };
    vi.unstubAllGlobals();
  });

  it("reads the service names off the registry's served shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ services: [{ name: "apollo", baseUrl: "http://a", openapiUrl: "http://a/openapi.json" }, { name: "instantly" }, { baseUrl: "no name" }] }), { status: 200 })),
    );
    expect(await fetchServiceList()).toEqual([{ service: "apollo" }, { service: "instantly" }]);
  });

  it("fails loud on an answer holding no services list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ service: "apollo" }]), { status: 200 })));
    await expect(fetchServiceList()).rejects.toThrow(/no `services` list/);
  });
});
