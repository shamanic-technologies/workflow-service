import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { transferBrand } from "../../src/lib/transfer-brand.js";

// Real Postgres (PGlite, in-process) with the service's own migrations applied,
// so the SQL the transfer runs is executed, not string-matched.
const MIGRATIONS = join(__dirname, "../../drizzle");

async function freshDb() {
  const client = new PGlite();
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) {
      if (stmt.trim()) await client.exec(stmt);
    }
  }
  return { client, db: drizzle(client) };
}

const SRC_ORG = "org-agency";
const TGT_ORG = "org-client";
const OTHER_ORG = "org-other";
const BRAND = "brand-doc";
const NEW_BRAND = "brand-doc-new";
const OTHER_BRAND = "brand-other";

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let n = 0;

async function workflow(o: { org: string; brand?: string | null; campaign?: string | null }) {
  n++;
  const res = await client.query<{ id: string }>(
    `INSERT INTO workflows (org_id, created_for_brand_id, campaign_id, workflow_slug, workflow_name,
       workflow_dynasty_slug, workflow_dynasty_name, feature_slug, signature, workflow_dynasty_signature_name, dag)
     VALUES ($1,$2,$3,$4,$4,$4,$4,'f',$4,$4,'{}'::jsonb) RETURNING id`,
    [o.org, o.brand ?? null, o.campaign ?? null, `wf-${n}`],
  );
  return res.rows[0].id;
}

async function run(o: { org: string; brands: string[] | null; campaign?: string | null; inputs?: object }) {
  const res = await client.query<{ id: string }>(
    `INSERT INTO workflow_runs (org_id, brand_ids, campaign_id, inputs) VALUES ($1,$2,$3,$4) RETURNING id`,
    [o.org, o.brands, o.campaign ?? null, o.inputs ? JSON.stringify(o.inputs) : null],
  );
  return res.rows[0].id;
}

async function runRow(id: string) {
  return (
    await client.query<{ org_id: string; brand_ids: string[] | null; inputs: Record<string, unknown> | null }>(
      `SELECT org_id, brand_ids, inputs FROM workflow_runs WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

async function wfRow(id: string) {
  return (
    await client.query<{ org_id: string; created_for_brand_id: string | null }>(
      `SELECT org_id, created_for_brand_id FROM workflows WHERE id = $1`,
      [id],
    )
  ).rows[0];
}

/** Anything left under the source org that still points at the brand. */
async function leftovers(brandIds: string[]) {
  const runs = await client.query(
    `SELECT id FROM workflow_runs WHERE org_id = $1 AND cardinality(brand_ids) = 1 AND brand_ids && $2::text[]`,
    [SRC_ORG, brandIds],
  );
  const wfs = await client.query(
    `SELECT id FROM workflows WHERE org_id = $1 AND created_for_brand_id = ANY($2::text[])`,
    [SRC_ORG, brandIds],
  );
  const inputs = await client.query(
    `SELECT id FROM workflow_runs WHERE brand_ids && $1::text[] AND cardinality(brand_ids) = 1 AND inputs->>'orgId' = $2`,
    [brandIds, SRC_ORG],
  );
  return runs.rows.length + wfs.rows.length + inputs.rows.length;
}

describe("transferBrand (real Postgres)", () => {
  beforeEach(async () => {
    ({ client, db } = await freshDb());
  }, 30_000);

  it("workflow_runs: moves the brand's solo-brand runs and rewrites inputs.orgId", async () => {
    const r = await run({
      org: SRC_ORG,
      brands: [BRAND],
      campaign: "camp-1",
      inputs: { orgId: SRC_ORG, brandId: BRAND, campaignId: "camp-1" },
    });

    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG });

    const row = await runRow(r);
    expect(row.org_id).toBe(TGT_ORG);
    expect(row.inputs).toEqual({ orgId: TGT_ORG, brandId: BRAND, campaignId: "camp-1" });
    expect(await leftovers([BRAND])).toBe(0);
  });

  it("workflow_runs: moves a run with no brand_ids that belongs to one of the brand's campaigns", async () => {
    await run({ org: SRC_ORG, brands: [BRAND], campaign: "camp-1" });
    const orphan = await run({ org: SRC_ORG, brands: null, campaign: "camp-1", inputs: { orgId: SRC_ORG } });
    const unrelated = await run({ org: SRC_ORG, brands: null, campaign: "camp-other" });

    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG });

    expect((await runRow(orphan)).org_id).toBe(TGT_ORG);
    expect((await runRow(orphan)).inputs).toEqual({ orgId: TGT_ORG });
    expect((await runRow(unrelated)).org_id).toBe(SRC_ORG);
  });

  it("workflow_runs: leaves other brands, other orgs and co-branded runs in place", async () => {
    const other = await run({ org: SRC_ORG, brands: [OTHER_BRAND], inputs: { orgId: SRC_ORG, brandId: OTHER_BRAND } });
    const coBrand = await run({ org: SRC_ORG, brands: [BRAND, OTHER_BRAND] });
    const elsewhere = await run({ org: OTHER_ORG, brands: [OTHER_BRAND] });

    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG });

    expect(await runRow(other)).toMatchObject({ org_id: SRC_ORG, inputs: { orgId: SRC_ORG, brandId: OTHER_BRAND } });
    expect(await runRow(coBrand)).toMatchObject({ org_id: SRC_ORG, brand_ids: [BRAND, OTHER_BRAND] });
    expect((await runRow(elsewhere)).org_id).toBe(OTHER_ORG);
  });

  it("workflows: moves workflows created for the brand or for one of its campaigns, never catalog workflows", async () => {
    await run({ org: SRC_ORG, brands: [BRAND], campaign: "camp-1" });
    const forBrand = await workflow({ org: SRC_ORG, brand: BRAND });
    const forCampaign = await workflow({ org: SRC_ORG, brand: null, campaign: "camp-1" });
    const catalog = await workflow({ org: SRC_ORG, brand: null });
    const otherBrand = await workflow({ org: SRC_ORG, brand: OTHER_BRAND });

    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG });

    expect((await wfRow(forBrand)).org_id).toBe(TGT_ORG);
    expect((await wfRow(forCampaign)).org_id).toBe(TGT_ORG);
    expect((await wfRow(catalog)).org_id).toBe(SRC_ORG);
    expect((await wfRow(otherBrand)).org_id).toBe(SRC_ORG);
  });

  it("targetBrandId: rewrites the brand id in columns, co-branded arrays and inputs.brandId", async () => {
    const r = await run({ org: SRC_ORG, brands: [BRAND], campaign: "camp-1", inputs: { orgId: SRC_ORG, brandId: BRAND } });
    const orphan = await run({ org: SRC_ORG, brands: null, campaign: "camp-1", inputs: { orgId: SRC_ORG, brandId: BRAND } });
    const coBrand = await run({ org: SRC_ORG, brands: [OTHER_BRAND, BRAND] });
    const wf = await workflow({ org: SRC_ORG, brand: BRAND });

    const res = await transferBrand(db, {
      sourceBrandId: BRAND,
      sourceOrgId: SRC_ORG,
      targetOrgId: TGT_ORG,
      targetBrandId: NEW_BRAND,
    });

    expect(await runRow(r)).toMatchObject({ org_id: TGT_ORG, brand_ids: [NEW_BRAND], inputs: { orgId: TGT_ORG, brandId: NEW_BRAND } });
    expect(await runRow(orphan)).toMatchObject({ org_id: TGT_ORG, inputs: { orgId: TGT_ORG, brandId: NEW_BRAND } });
    expect(await runRow(coBrand)).toMatchObject({ org_id: SRC_ORG, brand_ids: [OTHER_BRAND, NEW_BRAND] });
    expect(await wfRow(wf)).toEqual({ org_id: TGT_ORG, created_for_brand_id: NEW_BRAND });
    expect(await leftovers([BRAND, NEW_BRAND])).toBe(0);
    expect(res.updatedTables).toEqual([
      { tableName: "workflows", count: 1 },
      { tableName: "workflow_runs", count: 3 },
    ]);
  });

  it("repairs inputs.orgId on runs a previous transfer moved without touching inputs", async () => {
    const r = await run({ org: TGT_ORG, brands: [BRAND], inputs: { orgId: SRC_ORG } });

    await transferBrand(db, { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG });

    expect((await runRow(r)).inputs).toEqual({ orgId: TGT_ORG });
  });

  it("is idempotent: a second call changes nothing and reports zero", async () => {
    await run({ org: SRC_ORG, brands: [BRAND], campaign: "camp-1", inputs: { orgId: SRC_ORG, brandId: BRAND } });
    await run({ org: SRC_ORG, brands: null, campaign: "camp-1" });
    await workflow({ org: SRC_ORG, brand: BRAND });
    const params = { sourceBrandId: BRAND, sourceOrgId: SRC_ORG, targetOrgId: TGT_ORG, targetBrandId: NEW_BRAND };

    const first = await transferBrand(db, params);
    expect(first.updatedTables).toEqual([
      { tableName: "workflows", count: 1 },
      { tableName: "workflow_runs", count: 2 },
    ]);
    const snapshot = (await client.query(`SELECT * FROM workflow_runs ORDER BY id`)).rows;

    const second = await transferBrand(db, params);
    expect(second.updatedTables).toEqual([
      { tableName: "workflows", count: 0 },
      { tableName: "workflow_runs", count: 0 },
    ]);
    expect((await client.query(`SELECT * FROM workflow_runs ORDER BY id`)).rows).toEqual(snapshot);
  });
});
