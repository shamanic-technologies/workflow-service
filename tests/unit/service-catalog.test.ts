import { describe, it, expect } from "vitest";
import { SERVICE_CATALOG, getServiceCatalogForPrompt } from "../../src/lib/service-catalog.js";

describe("SERVICE_CATALOG", () => {
  it("has entries for all key services", () => {
    const names = SERVICE_CATALOG.map((s) => s.name);
    expect(names).toContain("campaign");
    expect(names).toContain("lead");
    expect(names).toContain("content-generation");
    expect(names).toContain("email-gateway");
    expect(names).toContain("stripe");
    expect(names).toContain("runs");
    expect(names).toContain("brand");
    expect(names).toContain("outlets");
    expect(names).toContain("journalists");
  });

  it("every entry has name, description, and keyEndpoints", () => {
    for (const service of SERVICE_CATALOG) {
      expect(service.name).toBeTruthy();
      expect(service.description).toBeTruthy();
      expect(service.keyEndpoints.length).toBeGreaterThan(0);
    }
  });
});

describe("getServiceCatalogForPrompt", () => {
  it("returns all services when no filter", () => {
    const text = getServiceCatalogForPrompt();
    expect(text).toContain("campaign");
    expect(text).toContain("stripe");
    expect(text).toContain("lead");
  });

  it("filters to specified services", () => {
    const text = getServiceCatalogForPrompt(["campaign", "lead"]);
    expect(text).toContain("campaign");
    expect(text).toContain("lead");
    expect(text).not.toContain("stripe");
  });

  it("returns empty string for empty filter", () => {
    const text = getServiceCatalogForPrompt([]);
    expect(text).toBe("");
  });
});
