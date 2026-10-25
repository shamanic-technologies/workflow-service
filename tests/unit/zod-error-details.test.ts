import { describe, it, expect } from "vitest";
import { z } from "zod";
import { zodErrorDetails } from "../../src/lib/zod-error-details.js";

describe("zodErrorDetails", () => {
  it("keeps the zod 3 wire shape { issues: [...], name: 'ZodError' } on a zod 4 error", () => {
    const parsed = z.object({ id: z.string() }).strict().safeParse({ extra: 1 });
    expect(parsed.success).toBe(false);
    const details = JSON.parse(JSON.stringify({ details: zodErrorDetails(parsed.error) })).details;
    expect(details.name).toBe("ZodError");
    expect(Array.isArray(details.issues)).toBe(true);
    expect(details.issues.map((i: { code: string }) => i.code).sort()).toEqual(["invalid_type", "unrecognized_keys"]);
    expect(details.issues.find((i: { code: string }) => i.code === "invalid_type").path).toEqual(["id"]);
  });
});
