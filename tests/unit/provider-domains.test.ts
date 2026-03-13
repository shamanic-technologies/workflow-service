import { describe, it, expect } from "vitest";
import {
  enrichProvidersWithDomains,
  PROVIDER_DOMAINS,
} from "../../src/lib/provider-domains.js";

describe("enrichProvidersWithDomains", () => {
  it("enriches known providers with their domain", () => {
    const result = enrichProvidersWithDomains(["anthropic", "apollo", "instantly"]);
    expect(result).toEqual([
      { name: "anthropic", domain: "anthropic.com" },
      { name: "apollo", domain: "apollo.io" },
      { name: "instantly", domain: "instantly.ai" },
    ]);
  });

  it("returns null domain for unknown providers", () => {
    const result = enrichProvidersWithDomains(["client", "transactional-email"]);
    expect(result).toEqual([
      { name: "client", domain: null },
      { name: "transactional-email", domain: null },
    ]);
  });

  it("handles mix of known and unknown providers", () => {
    const result = enrichProvidersWithDomains(["anthropic", "some-internal-service"]);
    expect(result).toEqual([
      { name: "anthropic", domain: "anthropic.com" },
      { name: "some-internal-service", domain: null },
    ]);
  });

  it("returns empty array for empty input", () => {
    expect(enrichProvidersWithDomains([])).toEqual([]);
  });

  it("covers all expected third-party providers", () => {
    const expectedProviders = [
      "anthropic",
      "openai",
      "apollo",
      "instantly",
      "stripe",
      "twilio",
      "postmark",
      "firecrawl",
      "ahrefs",
      "linkedin",
      "google",
      "meta",
    ];
    for (const provider of expectedProviders) {
      expect(PROVIDER_DOMAINS[provider]).toBeDefined();
    }
  });
});
