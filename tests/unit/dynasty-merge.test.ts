import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { workflows, type Workflow } from "../../src/db/schema.js";
import {
  applyMerge,
  applyUnmerge,
  openMergeOf,
  loadOpenMerges,
  finalSurvivor,
  mergeRefusal,
} from "../../src/lib/dynasty-merge.js";

// TPL-DYNASTY-1021-WF: real Postgres (PGlite) with the service's own migrations, so the merge SQL runs for real.
const MIGRATIONS = join(__dirname, "../../drizzle");

async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  return { client, db: drizzle(client) };
}

let client: PGlite;
let db: ReturnType<typeof drizzle>;

async function version(dynasty: string, v: number, status: "active" | "deprecated", extra: Record<string, unknown> = {}) {
  const slug = v === 1 ? dynasty : `${dynasty}-v${v}`;
  const [row] = await db
    .insert(workflows)
    .values({
      orgId: "org-1",
      workflowSlug: slug,
      workflowName: slug,
      workflowDynastySlug: dynasty,
      workflowDynastyName: dynasty.replace("sales-cold-email-outreach-", "Sales Cold Email Outreach "),
      featureSlug: "sales-cold-email-outreach",
      signature: `${slug}-sig`,
      workflowDynastySignatureName: dynasty,
      version: v,
      dag: { nodes: [], edges: [] },
      status,
      ...extra,
    })
    .returning();
  return row;
}

const lineage = (dynasty: string) => db.select().from(workflows).where(eq(workflows.workflowDynastySlug, dynasty)).orderBy(workflows.version);
const statusFields = (rows: Workflow[]) =>
  rows.map((r) => ({
    id: r.id,
    status: r.status,
    workflowDynastyStatus: r.workflowDynastyStatus,
    executableUntil: r.executableUntil?.toISOString() ?? null,
    executableUntilSource: r.executableUntilSource,
    deprecationReason: r.deprecationReason,
    deprecatedBy: r.deprecatedBy,
    deprecatedAt: r.deprecatedAt?.toISOString() ?? null,
    signature: r.signature,
    dag: r.dag,
    workflowSlug: r.workflowSlug,
  }));

const AZALEA = "sales-cold-email-outreach-azalea";
const MEBSUTA = "sales-cold-email-outreach-mebsuta";

describe("dynasty merge (PGlite)", () => {
  beforeEach(async () => {
    ({ client, db } = await freshDb());
    await version(AZALEA, 7, "deprecated", {
      executableUntil: new Date("2026-10-17T15:31:00Z"),
      executableUntilSource: "successor_created",
      deprecationReason: "Upgraded: replaced by version 8",
      deprecatedBy: "workflow-service",
      deprecatedAt: new Date("2026-10-17T15:31:00Z"),
    });
    await version(AZALEA, 8, "active");
    await version(MEBSUTA, 5, "active");
  }, 60_000);

  it("deprecates every absorbed version on both axes, naming the survivor, and records the prior state", async () => {
    const before = await lineage(AZALEA);
    const merge = await applyMerge(db, {
      absorbed: before,
      survivor: await lineage(MEBSUTA),
      legKeys: ["lead_found_to_conversation"],
      reason: "Same template dynasty and same model on the same pipe",
      decidedBy: "kevin@distribute.you",
    });
    expect(merge.survivorDynastySlug).toBe(MEBSUTA);
    const after = await lineage(AZALEA);
    for (const r of after) {
      expect(r.status).toBe("deprecated");
      expect(r.workflowDynastyStatus).toBe("deprecated");
      expect(r.deprecationReason).toBe(`Merged into Sales Cold Email Outreach mebsuta (${MEBSUTA}): Same template dynasty and same model on the same pipe`);
      expect(r.deprecatedBy).toBe("kevin@distribute.you");
      expect(r.executableUntil).not.toBeNull();
    }
    // v7's earlier stop instant is kept.
    expect(after[0].executableUntil!.toISOString()).toBe("2026-10-17T15:31:00.000Z");
    // History: slugs, signatures, DAGs untouched; the survivor untouched.
    expect(after.map((r) => [r.workflowSlug, r.signature])).toEqual(before.map((r) => [r.workflowSlug, r.signature]));
    expect((await lineage(MEBSUTA))[0].status).toBe("active");
    expect(finalSurvivor(AZALEA, await loadOpenMerges(db))).toBe(MEBSUTA);
  });

  it("un-merge restores the EXACT prior state of every version and keeps the record, closed", async () => {
    const before = statusFields(await lineage(AZALEA));
    await applyMerge(db, { absorbed: await lineage(AZALEA), survivor: await lineage(MEBSUTA), legKeys: ["lead_found_to_conversation"], reason: "dup", decidedBy: "a@b.c" });
    const open = (await openMergeOf(db, AZALEA))!;
    const closed = await applyUnmerge(db, open, { reason: "pilot check", decidedBy: "kevin@distribute.you" });
    expect(statusFields(await lineage(AZALEA))).toEqual(before);
    expect(closed.unmergedAt).not.toBeNull();
    expect(closed.unmergedBy).toBe("kevin@distribute.you");
    expect(await openMergeOf(db, AZALEA)).toBeUndefined();
    expect(finalSurvivor(AZALEA, await loadOpenMerges(db))).toBeNull();
    // A second merge after the un-merge is allowed (one OPEN merge per absorbed dynasty).
    await applyMerge(db, { absorbed: await lineage(AZALEA), survivor: await lineage(MEBSUTA), legKeys: ["lead_found_to_conversation"], reason: "again", decidedBy: null });
    expect(await openMergeOf(db, AZALEA)).toBeDefined();
  });

  // Regression (2026-10-21 pilot): stored stops carry MICROseconds; a snapshot through a JS Date restored them
  // rounded to the millisecond.
  it("un-merge restores timestamps to the microsecond", async () => {
    await client.exec(`UPDATE workflows SET executable_until = '2026-10-17 15:31:22.176025+00', deprecated_at = '2026-10-17 15:31:22.176025+00' WHERE workflow_slug = '${AZALEA}-v7'`);
    const text = async () => (await client.query<{ e: string; d: string }>(`SELECT executable_until::text e, deprecated_at::text d FROM workflows WHERE workflow_slug = '${AZALEA}-v7'`)).rows[0];
    const before = await text();
    await applyMerge(db, { absorbed: await lineage(AZALEA), survivor: await lineage(MEBSUTA), legKeys: ["x"], reason: "dup", decidedBy: null });
    await applyUnmerge(db, (await openMergeOf(db, AZALEA))!, { reason: "undo", decidedBy: null });
    expect(await text()).toEqual(before);
    expect(before.e).toContain(".176025");
  });

  it("the database refuses two open merges of one absorbed dynasty", async () => {
    const args = { absorbed: await lineage(AZALEA), survivor: await lineage(MEBSUTA), legKeys: ["x"], reason: "dup", decidedBy: null };
    await applyMerge(db, args);
    await expect(applyMerge(db, args)).rejects.toThrow();
  });
});

describe("mergeRefusal", () => {
  const row = (dynasty: string, o: Partial<Workflow> = {}) =>
    ({ workflowDynastySlug: dynasty, workflowDynastyName: dynasty, featureSlug: "sales-cold-email-outreach", status: "active", workflowDynastyStatus: "active", ...o }) as Workflow;
  const base = {
    absorbedSlug: "a",
    absorbed: [row("a")],
    survivor: [row("b")],
    absorbedLegs: ["lead_found_to_conversation"],
    survivorLegs: ["lead_found_to_conversation"],
    openMerges: new Map<string, string>(),
  };

  it("lets a same-pipe merge through", () => {
    expect(mergeRefusal(base)).toBeNull();
  });

  it("never merges across two pipes: another leg, no leg, or another channel", () => {
    expect(mergeRefusal({ ...base, survivorLegs: ["lead_found_to_website_visit"] })?.code).toBe("merge_across_pipes");
    expect(mergeRefusal({ ...base, absorbedLegs: [] })?.code).toBe("merge_across_pipes");
    expect(mergeRefusal({ ...base, survivor: [row("b", { featureSlug: "feedback-request-cold-email-outreach" })] })?.code).toBe("merge_across_pipes");
  });

  it("refuses itself, an already-merged dynasty, a merged survivor and non-executable sides", () => {
    expect(mergeRefusal({ ...base, survivor: [row("a")] })?.code).toBe("merge_into_itself");
    expect(mergeRefusal({ ...base, openMerges: new Map([["a", "c"]]) })?.code).toBe("already_merged");
    expect(mergeRefusal({ ...base, openMerges: new Map([["b", "c"]]) })?.code).toBe("survivor_merged");
    expect(mergeRefusal({ ...base, survivor: [row("b", { status: "deprecated" })] })?.code).toBe("survivor_not_executable");
    expect(mergeRefusal({ ...base, absorbed: [row("a", { workflowDynastyStatus: "deprecated" })] })?.code).toBe("absorbed_not_executable");
  });
});

describe("finalSurvivor", () => {
  it("resolves chains and guards cycles", () => {
    expect(finalSurvivor("a", new Map([["a", "b"], ["b", "c"]]))).toBe("c");
    expect(finalSurvivor("z", new Map([["a", "b"]]))).toBeNull();
    expect(finalSurvivor("a", new Map([["a", "b"], ["b", "a"]]))).toBe("a");
  });
});
