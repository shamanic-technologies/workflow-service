import { describe, it, expect } from "vitest";
import { UpgradeWorkflowFromDescriptionSchema } from "../../src/schemas.js";

describe("UpgradeWorkflowFromDescriptionSchema", () => {
  const VALID_DESCRIPTION = "Patch the email-generate node $ref paths to match the lead service schema.";

  it("accepts workflowDynastySlug + description", () => {
    const result = UpgradeWorkflowFromDescriptionSchema.safeParse({
      workflowDynastySlug: "sales-cold-email-outreach-eden",
      description: VALID_DESCRIPTION,
    });
    expect(result.success).toBe(true);
  });

  it("rejects legacy workflowSlug field (post-rename: bigbang)", () => {
    const result = UpgradeWorkflowFromDescriptionSchema.safeParse({
      workflowSlug: "sales-cold-email-outreach-eden",
      description: VALID_DESCRIPTION,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues.map((i) => i.path.join("."));
      expect(issues).toContain("workflowDynastySlug");
    }
  });

  it("rejects missing workflowDynastySlug", () => {
    const result = UpgradeWorkflowFromDescriptionSchema.safeParse({
      description: VALID_DESCRIPTION,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty workflowDynastySlug", () => {
    const result = UpgradeWorkflowFromDescriptionSchema.safeParse({
      workflowDynastySlug: "",
      description: VALID_DESCRIPTION,
    });
    expect(result.success).toBe(false);
  });

  it("rejects when both dag and description absent", () => {
    const result = UpgradeWorkflowFromDescriptionSchema.safeParse({
      workflowDynastySlug: "sales-cold-email-outreach-eden",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("Either"))).toBe(true);
    }
  });

  it("accepts workflowDynastySlug + dag (no description)", () => {
    const dag = {
      nodes: [
        {
          id: "n1",
          type: "http.call",
          config: { service: "campaign", method: "POST", path: "/foo" },
        },
      ],
      edges: [],
    };
    const result = UpgradeWorkflowFromDescriptionSchema.safeParse({
      workflowDynastySlug: "sales-cold-email-outreach-eden",
      dag,
    });
    expect(result.success).toBe(true);
  });
});
