import { describe, it, expect } from "vitest";
import { assertEnvironmentConsistency } from "../../src/lib/env-safety.js";

describe("assertEnvironmentConsistency", () => {
  it("throws when RAILWAY_ENVIRONMENT_NAME=staging and WINDMILL_SERVER_URL points to prod", () => {
    expect(() =>
      assertEnvironmentConsistency({
        RAILWAY_ENVIRONMENT_NAME: "staging",
        WINDMILL_SERVER_URL: "https://windmill-production-433f.up.railway.app",
      }),
    ).toThrow(/WINDMILL_SERVER_URL.*production/);
  });

  it("throws when RAILWAY_ENVIRONMENT_NAME=production and API_REGISTRY_SERVICE_URL points to staging", () => {
    expect(() =>
      assertEnvironmentConsistency({
        RAILWAY_ENVIRONMENT_NAME: "production",
        API_REGISTRY_SERVICE_URL:
          "https://api-registry-staging.distribute.you",
      }),
    ).toThrow(/API_REGISTRY_SERVICE_URL.*staging/);
  });

  it("passes when staging env has staging URLs", () => {
    expect(() =>
      assertEnvironmentConsistency({
        RAILWAY_ENVIRONMENT_NAME: "staging",
        WINDMILL_SERVER_URL:
          "https://windmill-server-staging-c363.up.railway.app",
        API_REGISTRY_SERVICE_URL:
          "https://api-registry-staging.distribute.you",
      }),
    ).not.toThrow();
  });

  it("passes when production env has production URLs", () => {
    expect(() =>
      assertEnvironmentConsistency({
        RAILWAY_ENVIRONMENT_NAME: "production",
        WINDMILL_SERVER_URL: "https://windmill-production-433f.up.railway.app",
        API_REGISTRY_SERVICE_URL: "https://api-registry.distribute.you",
      }),
    ).not.toThrow();
  });

  it("skips check when RAILWAY_ENVIRONMENT_NAME is unset (local dev)", () => {
    expect(() =>
      assertEnvironmentConsistency({
        WINDMILL_SERVER_URL: "https://windmill-production-433f.up.railway.app",
      }),
    ).not.toThrow();
  });

  it("ignores ambiguous URLs (railway.internal, no env marker)", () => {
    expect(() =>
      assertEnvironmentConsistency({
        RAILWAY_ENVIRONMENT_NAME: "staging",
        WINDMILL_SERVER_URL: "http://windmill-server.railway.internal:8000",
      }),
    ).not.toThrow();
  });

  it("reports multiple mismatches in one error", () => {
    expect(() =>
      assertEnvironmentConsistency({
        RAILWAY_ENVIRONMENT_NAME: "staging",
        WINDMILL_SERVER_URL: "https://windmill-production-433f.up.railway.app",
        API_REGISTRY_SERVICE_URL: "https://api-registry.distribute.you",
      }),
    ).toThrow(/WINDMILL_SERVER_URL/);
  });
});
