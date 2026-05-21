import { describe, it, expect } from "vitest";
import { DAGNodeSchema } from "../../src/schemas.js";

describe("DAGNodeSchema.type enum", () => {
  it("accepts http.call", () => {
    const result = DAGNodeSchema.safeParse({
      id: "x",
      type: "http.call",
      config: { service: "lead", method: "POST", path: "/buffer/next" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts script", () => {
    const result = DAGNodeSchema.safeParse({
      id: "x",
      type: "script",
      config: {
        code: "export async function main() { return { ok: true }; }",
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts condition, wait, for-each natives", () => {
    expect(
      DAGNodeSchema.safeParse({ id: "c", type: "condition" }).success
    ).toBe(true);
    expect(
      DAGNodeSchema.safeParse({ id: "w", type: "wait", config: { seconds: 5 } })
        .success
    ).toBe(true);
    expect(
      DAGNodeSchema.safeParse({
        id: "f",
        type: "for-each",
        config: { iterator: "flow_input.items" },
      }).success
    ).toBe(true);
  });

  it("rejects unknown type via z.enum", () => {
    const result = DAGNodeSchema.safeParse({
      id: "x",
      type: "foobar",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty type via z.enum", () => {
    const result = DAGNodeSchema.safeParse({
      id: "x",
      type: "",
    });
    expect(result.success).toBe(false);
  });
});
