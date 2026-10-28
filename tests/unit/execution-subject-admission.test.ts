import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { workflows, type Workflow } from "../../src/db/schema.js";
import {
  campaignExecutionKey,
  reserveCampaignExecution,
  type ExecutionConflictPolicy,
} from "../../src/lib/execution-admission.js";

// REACTIVE-THROUGHPUT-1028-WF: real Postgres (PGlite, real migrations) so the
// advisory lock, the active-key read and the partial unique index all run.
const MIGRATIONS = join(__dirname, "../../drizzle");

async function setup() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  const database = drizzle(client);
  const [workflow] = await database
    .insert(workflows)
    .values({
      orgId: "org",
      workflowSlug: "ai-follow-up-email-test",
      workflowName: "AI Follow Up Email Test",
      workflowDynastySlug: "ai-follow-up-email-test",
      workflowDynastyName: "AI Follow Up Email Test",
      featureSlug: "ai-follow-up-email",
      signature: "sig",
      workflowDynastySignatureName: "test",
      dag: {},
      creationType: "scratch",
    })
    .returning();
  return { database, workflow: workflow as Workflow };
}

function reserve(
  ctx: Awaited<ReturnType<typeof setup>>,
  o: { campaignId?: string; subject?: string; policy?: ExecutionConflictPolicy },
) {
  return reserveCampaignExecution({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    database: ctx.database as any,
    workflow: ctx.workflow,
    orgId: "org",
    userId: "user",
    campaignId: o.campaignId ?? "camp",
    brandIds: [],
    featureSlug: "ai-follow-up-email",
    inputs: {},
    attributionContext: null,
    conflictPolicy: o.policy ?? "reject",
    executionSubject: o.subject,
  });
}

describe("execution admission per subject", () => {
  it("keeps the campaign-wide key byte-identical when no subject is stated", () => {
    expect(campaignExecutionKey("org", "camp")).toBe("campaign:org:camp");
    expect(campaignExecutionKey("org", "camp", "lead:1")).toBe("campaign:org:camp:subject:lead:1");
  });

  it("admits a parallel burst of one campaign naming N distinct subjects", async () => {
    const ctx = await setup();
    const n = 25;
    const results = await Promise.all(
      Array.from({ length: n }, (_, i) => reserve(ctx, { subject: `lead:${i}` })),
    );
    expect(results.every((r) => r.kind === "reserved")).toBe(true);
    expect(new Set(results.map((r) => r.executionKey)).size).toBe(n);
  });

  it("admits one and conflicts the other when two name the SAME subject", async () => {
    const ctx = await setup();
    const results = await Promise.all([
      reserve(ctx, { subject: "lead:same" }),
      reserve(ctx, { subject: "lead:same" }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "reserved"]);
    const reserved = results.find((r) => r.kind === "reserved")!;
    const conflict = results.find((r) => r.kind === "conflict")!;
    expect(conflict.run.id).toBe(reserved.run.id);
  });

  it("keeps campaign-wide admission when no subject is stated", async () => {
    const ctx = await setup();
    const results = await Promise.all([reserve(ctx, {}), reserve(ctx, {})]);
    expect(results.map((r) => r.kind).sort()).toEqual(["conflict", "reserved"]);
    expect(results[0].executionKey).toBe("campaign:org:camp");
  });

  it("scopes a subject to its campaign", async () => {
    const ctx = await setup();
    const a = await reserve(ctx, { campaignId: "camp-a", subject: "lead:1" });
    const b = await reserve(ctx, { campaignId: "camp-b", subject: "lead:1" });
    expect([a.kind, b.kind]).toEqual(["reserved", "reserved"]);
  });

  it("lets a subject execution and a campaign-wide one run side by side", async () => {
    const ctx = await setup();
    const wide = await reserve(ctx, {});
    const subj = await reserve(ctx, { subject: "lead:1" });
    expect([wide.kind, subj.kind]).toEqual(["reserved", "reserved"]);
  });
});
