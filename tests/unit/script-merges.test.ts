import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import { listMerges, mergeScript, unmergeScript } from "../../src/lib/scripts/script-merges.js";
import { scripts } from "../../src/db/schema.js";
import { testNamer } from "../helpers/script-names.js";

// ONE-WRITER-N-MODELS-1116: a per-model copy merged into what it now runs as, at each place; never destructive.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}
const CODE = `export default function run(ctx) { return null; }`;
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };

let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
  for (const [o, d] of [
    ["email_sent", "dy_cold__claude_haiku__cresn"],
    ["email_sent", "dy_cold"],
    ["message_written", "dy_free_offer"],
    ["llm_completion", "dy_claude_haiku"],
  ]) await createScript(db, { outcome: o!, dynasty: d!, code: CODE, description: "x" }, author, known);
}, 60_000);

const copy = { outcome: "email_sent", dynasty: "dy_cold__claude_haiku__cresn" };
const places = [
  { survivor: { outcome: "message_written", dynasty: "dy_free_offer" }, askedBy: "email_sent/dy_cold" },
  { survivor: { outcome: "llm_completion", dynasty: "dy_claude_haiku" }, askedBy: "message_written/dy_free_offer" },
];
const status = async (o: string, d: string) => (await db.select().from(scripts).where(and(eq(scripts.outcome, o), eq(scripts.dynasty, d))))[0]!;

describe("script merges", () => {
  it("retires the copy with the reason and serves one row per place", async () => {
    const out = await mergeScript(db, { absorbed: copy, places, reason: "one writer, the model is its own Engine", mergedBy: "staff@example.com" });
    expect(out.map((m) => [m.survivor, m.askedBy])).toEqual([
      ["message_written/dy_free_offer", "email_sent/dy_cold"],
      ["llm_completion/dy_claude_haiku", "message_written/dy_free_offer"],
    ]);
    const row = await status(copy.outcome, copy.dynasty);
    expect([row.status, row.dynastyStatus]).toEqual(["deprecated", "deprecated"]);
    expect(row.deprecationReason).toContain("Merged into message_written/dy_free_offer (asked by email_sent/dy_cold), llm_completion/dy_claude_haiku");
    expect((await listMerges(db)).length).toBe(2);
  });

  it("refuses a survivor that does not run, a second merge, a merge into itself, and writes nothing", async () => {
    await expect(mergeScript(db, { absorbed: copy, places: [{ survivor: { outcome: "message_written", dynasty: "dy_nope" }, askedBy: null }], reason: "why not", mergedBy: "s" })).rejects.toMatchObject({ code: "survivor_not_runnable" });
    await expect(mergeScript(db, { absorbed: copy, places: [{ survivor: copy, askedBy: null }], reason: "why not", mergedBy: "s" })).rejects.toMatchObject({ code: "merge_into_itself" });
    expect((await status(copy.outcome, copy.dynasty)).status).toBe("active");
    expect(await listMerges(db)).toEqual([]);
    await mergeScript(db, { absorbed: copy, places, reason: "first", mergedBy: "s" });
    await expect(mergeScript(db, { absorbed: copy, places, reason: "again", mergedBy: "s" })).rejects.toMatchObject({ code: "already_merged" });
  });

  it("an unmerge brings the copy back and closes its rows", async () => {
    await mergeScript(db, { absorbed: copy, places, reason: "first", mergedBy: "s" });
    expect(await unmergeScript(db, copy, "the owner wants it back")).toEqual({ closed: 2 });
    expect((await status(copy.outcome, copy.dynasty)).status).toBe("active");
    expect(await listMerges(db)).toEqual([]);
  });
});
