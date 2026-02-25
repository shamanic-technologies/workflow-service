import { describe, it, expect } from "vitest";
import { extractHttpEndpoints } from "../../src/lib/extract-http-endpoints.js";
import {
  VALID_LINEAR_DAG,
  DAG_WITH_HTTP_CALL,
  DAG_WITH_HTTP_CALL_CHAIN,
} from "../helpers/fixtures.js";

describe("extractHttpEndpoints", () => {
  it("returns empty array for DAG with no http.call nodes", () => {
    const result = extractHttpEndpoints(VALID_LINEAR_DAG);
    expect(result).toEqual([]);
  });

  it("extracts single http.call endpoint", () => {
    const result = extractHttpEndpoints(DAG_WITH_HTTP_CALL);
    expect(result).toEqual([
      { service: "stripe", method: "GET", path: "/products/prod_123" },
    ]);
  });

  it("extracts multiple http.call endpoints from a chain", () => {
    const result = extractHttpEndpoints(DAG_WITH_HTTP_CALL_CHAIN);
    expect(result).toEqual([
      { service: "client", method: "POST", path: "/users" },
      { service: "transactional-email", method: "POST", path: "/send" },
    ]);
  });

  it("deduplicates identical endpoints", () => {
    const dag = {
      nodes: [
        { id: "call-1", type: "http.call", config: { service: "stripe", method: "POST", path: "/products" } },
        { id: "call-2", type: "http.call", config: { service: "stripe", method: "POST", path: "/products" } },
      ],
      edges: [],
    };
    const result = extractHttpEndpoints(dag);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ service: "stripe", method: "POST", path: "/products" });
  });

  it("keeps endpoints with different methods as separate", () => {
    const dag = {
      nodes: [
        { id: "call-1", type: "http.call", config: { service: "stripe", method: "GET", path: "/products" } },
        { id: "call-2", type: "http.call", config: { service: "stripe", method: "POST", path: "/products" } },
      ],
      edges: [],
    };
    const result = extractHttpEndpoints(dag);
    expect(result).toHaveLength(2);
  });

  it("skips http.call nodes with missing config", () => {
    const dag = {
      nodes: [
        { id: "bad", type: "http.call" },
        { id: "good", type: "http.call", config: { service: "stripe", method: "GET", path: "/products" } },
      ],
      edges: [],
    };
    const result = extractHttpEndpoints(dag);
    expect(result).toHaveLength(1);
  });

  it("skips http.call nodes with non-string config values", () => {
    const dag = {
      nodes: [
        { id: "bad", type: "http.call", config: { service: 123, method: "GET", path: "/x" } },
      ],
      edges: [],
    };
    const result = extractHttpEndpoints(dag);
    expect(result).toEqual([]);
  });

  it("ignores non-http.call nodes even if they have service in config", () => {
    const dag = {
      nodes: [
        { id: "lead", type: "lead-service", config: { service: "apollo", method: "POST", path: "/search" } },
        { id: "call", type: "http.call", config: { service: "stripe", method: "GET", path: "/products" } },
      ],
      edges: [],
    };
    const result = extractHttpEndpoints(dag);
    expect(result).toHaveLength(1);
    expect(result[0].service).toBe("stripe");
  });
});
