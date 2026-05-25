import { describe, it, expect } from "vitest";
import {
  resolveSchema,
  walkSchemaPath,
  getRequestBodySchema,
  getResponseSchema,
} from "../../src/lib/openapi-schema-resolver.js";

describe("resolveSchema", () => {
  it("resolves a direct schema with properties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    };
    const result = resolveSchema(schema, {});
    expect(result).toEqual({
      properties: { name: { type: "string" }, age: { type: "number" } },
      required: ["name"],
    });
  });

  it("follows $ref to components/schemas", () => {
    const schema = { $ref: "#/components/schemas/User" };
    const spec = {
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "string" }, email: { type: "string" } },
            required: ["id", "email"],
          },
        },
      },
    };
    const result = resolveSchema(schema, spec);
    expect(result).toEqual({
      properties: { id: { type: "string" }, email: { type: "string" } },
      required: ["id", "email"],
    });
  });

  it("handles nested $ref (schema references another schema)", () => {
    const schema = { $ref: "#/components/schemas/Alias" };
    const spec = {
      components: {
        schemas: {
          Alias: { $ref: "#/components/schemas/Real" },
          Real: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      },
    };
    const result = resolveSchema(schema, spec);
    expect(result).toEqual({
      properties: { value: { type: "string" } },
      required: ["value"],
    });
  });

  it("handles allOf by merging properties", () => {
    const schema = {
      allOf: [
        {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        {
          type: "object",
          properties: { b: { type: "number" } },
          required: ["b"],
        },
      ],
    };
    const result = resolveSchema(schema, {});
    expect(result?.properties).toEqual({ a: { type: "string" }, b: { type: "number" } });
    expect(result?.required).toEqual(["a", "b"]);
  });

  it("handles oneOf by merging all variants' properties", () => {
    const schema = {
      oneOf: [
        { type: "object", properties: { x: { type: "string" } } },
        { type: "object", properties: { y: { type: "number" } } },
      ],
    };
    const result = resolveSchema(schema, {});
    expect(result?.properties).toEqual({ x: { type: "string" }, y: { type: "number" } });
  });

  it("returns null for schemas without properties", () => {
    expect(resolveSchema({ type: "string" }, {})).toBeNull();
    expect(resolveSchema({ type: "array", items: { type: "string" } }, {})).toBeNull();
  });

  it("handles circular $ref gracefully (depth limit)", () => {
    const schema = { $ref: "#/components/schemas/Loop" };
    const spec = {
      components: { schemas: { Loop: { $ref: "#/components/schemas/Loop" } } },
    };
    expect(resolveSchema(schema, spec)).toBeNull();
  });

  it("returns empty required array when required is not defined", () => {
    const schema = { type: "object", properties: { foo: { type: "string" } } };
    const result = resolveSchema(schema, {});
    expect(result?.required).toEqual([]);
  });
});

describe("walkSchemaPath", () => {
  it("traverses array items when path segment is numeric (regression: results.0.value false positive)", () => {
    // brand POST /brands/{brandId}/extract-fields returns { results: [{ key, value, ... }] }
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
              },
              required: ["key", "value"],
            },
          },
        },
        required: ["results"],
      },
      {},
    )!;

    // results.0.value should be valid — array index 0, then object property "value"
    const result = walkSchemaPath(schema, ["results", "0", "value"], {});
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toEqual(["results", "0", "value"]);
  });

  it("rejects non-numeric segment on array schema", () => {
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: { key: { type: "string" } },
            },
          },
        },
      },
      {},
    )!;

    const result = walkSchemaPath(schema, ["results", "foo"], {});
    expect(result.valid).toBe(false);
  });

  it("traverses array items via $ref", () => {
    const spec = {
      components: {
        schemas: {
          ExtractResult: {
            type: "object",
            properties: {
              key: { type: "string" },
              value: { type: "string" },
            },
          },
        },
      },
    };

    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: { $ref: "#/components/schemas/ExtractResult" },
          },
        },
      },
      spec,
    )!;

    const result = walkSchemaPath(schema, ["results", "0", "value"], spec);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid nested field after array index", () => {
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                key: { type: "string" },
                value: { type: "string" },
              },
            },
          },
        },
      },
      {},
    )!;

    const result = walkSchemaPath(schema, ["results", "0", "nonexistent"], {});
    expect(result.valid).toBe(false);
    expect(result.availableAt).toContain("key");
    expect(result.availableAt).toContain("value");
  });
});

describe("walkSchemaPath with additionalProperties (dynamic keys)", () => {
  // Mirrors brand-service POST /orgs/brands/extract-fields response:
  //   { brands: BrandMeta[], fields: { <dynamic-key>: MultiBrandFieldValue } }
  // The `fields` object uses `additionalProperties` (caller-chosen keys), so
  // walkSchemaPath must descend into the additionalProperties value schema
  // when a property lookup fails instead of rejecting with empty availableAt.
  const brandSpec = {
    components: {
      schemas: {
        MultiBrandFieldValue: {
          type: "object",
          properties: {
            value: { type: "string" },
            byBrand: {
              type: "object",
              additionalProperties: { $ref: "#/components/schemas/BrandFieldDetail" },
            },
          },
          required: ["value", "byBrand"],
        },
        BrandFieldDetail: {
          type: "object",
          properties: {
            value: { type: "string" },
            cached: { type: "boolean" },
          },
          required: ["value", "cached"],
        },
      },
    },
  };

  const brandResponseSchema = resolveSchema(
    {
      type: "object",
      properties: {
        brands: {
          type: "array",
          items: {
            type: "object",
            properties: { brandId: { type: "string" }, domain: { type: "string" } },
          },
        },
        fields: {
          type: "object",
          additionalProperties: { $ref: "#/components/schemas/MultiBrandFieldValue" },
        },
      },
      required: ["brands", "fields"],
    },
    brandSpec,
  )!;

  it("accepts dynamic key then known sub-property (fields.founders.value)", () => {
    const result = walkSchemaPath(
      brandResponseSchema,
      ["fields", "founders", "value"],
      brandSpec,
    );
    expect(result.valid).toBe(true);
    expect(result.resolvedPath).toEqual(["fields", "founders", "value"]);
  });

  it("accepts terminal dynamic key (fields.anyKey)", () => {
    const result = walkSchemaPath(brandResponseSchema, ["fields", "anyKey"], brandSpec);
    expect(result.valid).toBe(true);
  });

  it("rejects unknown sub-property after dynamic key (fields.founders.bogus)", () => {
    const result = walkSchemaPath(
      brandResponseSchema,
      ["fields", "founders", "bogus"],
      brandSpec,
    );
    expect(result.valid).toBe(false);
    expect(result.availableAt).toContain("value");
    expect(result.availableAt).toContain("byBrand");
  });

  it("traverses nested additionalProperties (fields.founders.byBrand.acme.value)", () => {
    const result = walkSchemaPath(
      brandResponseSchema,
      ["fields", "founders", "byBrand", "acme.com", "value"],
      brandSpec,
    );
    expect(result.valid).toBe(true);
  });

  it("handles additionalProperties: true (open map, accepts any further path)", () => {
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          meta: { type: "object", additionalProperties: true },
        },
      },
      {},
    )!;
    expect(walkSchemaPath(schema, ["meta", "whatever"], {}).valid).toBe(true);
    expect(walkSchemaPath(schema, ["meta", "deep", "key"], {}).valid).toBe(true);
  });

  it("mixed properties + additionalProperties: named key resolves via properties", () => {
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          mixed: {
            type: "object",
            properties: { knownField: { type: "string" } },
            additionalProperties: { type: "number" },
          },
        },
      },
      {},
    )!;
    expect(walkSchemaPath(schema, ["mixed", "knownField"], {}).valid).toBe(true);
    expect(walkSchemaPath(schema, ["mixed", "anyOtherKey"], {}).valid).toBe(true);
  });

  it("regression: schema without additionalProperties still rejects unknown keys", () => {
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          strict: {
            type: "object",
            properties: { knownField: { type: "string" } },
          },
        },
      },
      {},
    )!;
    const result = walkSchemaPath(schema, ["strict", "unknown"], {});
    expect(result.valid).toBe(false);
    expect(result.availableAt).toEqual(["knownField"]);
  });
});

describe("walkSchemaPath availableAt drill-down (1-level nested keys)", () => {
  // Mirrors lead-service POST /orgs/buffer/next response shape: the `data` object
  // has scalar keys (firstName, leadId) plus an `organization` sub-object. When a
  // caller tries `lead.data.organizationName` (flat — does not exist), they should
  // see "organization{name,industry,...}" in the failure listing so they know to
  // descend without a second guess-and-check round-trip.
  const leadResponseSchema = resolveSchema(
    {
      type: "object",
      properties: {
        lead: {
          type: "object",
          properties: {
            data: {
              type: "object",
              properties: {
                leadId: { type: "string" },
                firstName: { type: "string" },
                currentTitle: { type: "string" },
                organization: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    industry: { type: "string" },
                    estimatedNumEmployees: { type: "number" },
                    annualRevenue: { type: "number" },
                  },
                },
              },
            },
          },
        },
      },
    },
    {},
  )!;

  it("inlines object-typed sibling keys at the failure depth", () => {
    const result = walkSchemaPath(
      leadResponseSchema,
      ["lead", "data", "organizationName"],
      {},
    );
    expect(result.valid).toBe(false);
    expect(result.availableAt).toContain("leadId");
    expect(result.availableAt).toContain("firstName");
    expect(result.availableAt).toContain("currentTitle");
    expect(result.availableAt).toContain(
      "organization{name,industry,estimatedNumEmployees,annualRevenue}",
    );
  });

  it("keeps scalar siblings bare (no curly suffix)", () => {
    const result = walkSchemaPath(
      leadResponseSchema,
      ["lead", "data", "bogus"],
      {},
    );
    expect(result.availableAt).toContain("leadId");
    expect(result.availableAt?.find((k) => k.startsWith("leadId"))).toBe("leadId");
  });

  it("truncates wide objects at 5 sub-keys with ellipsis", () => {
    const wideSchema = resolveSchema(
      {
        type: "object",
        properties: {
          outer: {
            type: "object",
            properties: {
              wide: {
                type: "object",
                properties: {
                  a: { type: "string" },
                  b: { type: "string" },
                  c: { type: "string" },
                  d: { type: "string" },
                  e: { type: "string" },
                  f: { type: "string" },
                  g: { type: "string" },
                },
              },
            },
          },
        },
      },
      {},
    )!;
    const result = walkSchemaPath(wideSchema, ["outer", "missing"], {});
    expect(result.availableAt).toContain("wide{a,b,c,d,e,...}");
  });

  it("resolves $ref when listing nested sub-keys", () => {
    const spec = {
      components: {
        schemas: {
          Organization: {
            type: "object",
            properties: {
              name: { type: "string" },
              industry: { type: "string" },
            },
          },
        },
      },
    };
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              organization: { $ref: "#/components/schemas/Organization" },
              firstName: { type: "string" },
            },
          },
        },
      },
      spec,
    )!;

    const result = walkSchemaPath(schema, ["data", "missing"], spec);
    expect(result.availableAt).toContain("firstName");
    expect(result.availableAt).toContain("organization{name,industry}");
  });

  it("falls back to bare key when sub-schema has no properties (e.g. additionalProperties-only)", () => {
    // brand-service extract-fields shape: outer.fields is an object with only
    // additionalProperties, no properties. Formatter must NOT crash and should
    // keep the key bare.
    const schema = resolveSchema(
      {
        type: "object",
        properties: {
          outer: {
            type: "object",
            properties: {
              fields: {
                type: "object",
                additionalProperties: { type: "string" },
              },
              scalar: { type: "string" },
            },
          },
        },
      },
      {},
    )!;
    const result = walkSchemaPath(schema, ["outer", "missing"], {});
    expect(result.availableAt).toContain("fields");
    expect(result.availableAt).toContain("scalar");
  });
});

describe("getRequestBodySchema", () => {
  const spec = {
    paths: {
      "/gate-check": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    campaignId: { type: "string" },
                    orgId: { type: "string" },
                  },
                  required: ["campaignId", "orgId"],
                },
              },
            },
          },
        },
      },
      "/health": {
        get: { summary: "Health check" },
      },
    },
  };

  it("returns schema for POST endpoint with requestBody", () => {
    const result = getRequestBodySchema(spec, "/gate-check", "POST");
    expect(result?.properties).toHaveProperty("campaignId");
    expect(result?.properties).toHaveProperty("orgId");
    expect(result?.required).toEqual(["campaignId", "orgId"]);
  });

  it("returns null for GET endpoint (no requestBody)", () => {
    expect(getRequestBodySchema(spec, "/health", "GET")).toBeNull();
  });

  it("returns null when path does not exist", () => {
    expect(getRequestBodySchema(spec, "/nonexistent", "POST")).toBeNull();
  });

  it("handles simplified format (schema directly on requestBody)", () => {
    const simplified = {
      paths: {
        "/send": {
          post: {
            requestBody: {
              schema: {
                type: "object",
                properties: { to: { type: "string" } },
                required: ["to"],
              },
            },
          },
        },
      },
    };
    const result = getRequestBodySchema(simplified, "/send", "POST");
    expect(result?.properties).toHaveProperty("to");
    expect(result?.required).toEqual(["to"]);
  });

  it("resolves $ref in requestBody schema", () => {
    const specWithRef = {
      paths: {
        "/create": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreateReq" },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          CreateReq: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
      },
    };
    const result = getRequestBodySchema(specWithRef, "/create", "POST");
    expect(result?.properties).toHaveProperty("name");
  });
});

describe("getResponseSchema", () => {
  it("returns schema for 200 response", () => {
    const spec = {
      paths: {
        "/check": {
          post: {
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { allowed: { type: "boolean" } },
                      required: ["allowed"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = getResponseSchema(spec, "/check", "POST");
    expect(result?.properties).toHaveProperty("allowed");
  });

  it("falls back to 201 response", () => {
    const spec = {
      paths: {
        "/create": {
          post: {
            responses: {
              "201": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    const result = getResponseSchema(spec, "/create", "POST");
    expect(result?.properties).toHaveProperty("id");
  });

  it("handles simplified format (schema directly on response)", () => {
    const spec = {
      paths: {
        "/run": {
          post: {
            responses: {
              "200": {
                schema: {
                  type: "object",
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
        },
      },
    };
    const result = getResponseSchema(spec, "/run", "POST");
    expect(result?.properties).toHaveProperty("status");
  });

  it("returns null when no response schema exists", () => {
    const spec = {
      paths: { "/noop": { post: { responses: { "204": {} } } } },
    };
    expect(getResponseSchema(spec, "/noop", "POST")).toBeNull();
  });
});
