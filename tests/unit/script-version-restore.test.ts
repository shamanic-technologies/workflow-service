import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { ScriptCatalogueError, createScript, dynastyVersions, restoreScriptVersion, upgradeScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";

// WRITERS-NO-MODEL-1126 (prod 2026-11-26): message_written/dy_answer_lead v7 and dy_follow_up_due v4 could not be proven
// before December, so every model was held out and nobody was answered; their previous versions were put back live.
// An earlier version can be restored (the active one parked with the reason), and an upgrade after it is numbered past
// every version (never active + 1, which would collide with the parked one).
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}
const CODE = `
import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
export default function run(ctx: ScriptContext): ScriptResult {
  return { content: { said: "v1" } };
}`;
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const deps = { isKnownOutcome: async () => true, nameDynasties: async (_o: string, toName: Array<{ dynasty: string; description: string }>) => new Map(toName.map((d) => [d.dynasty, d.description])) };
let db: AnyPgDb;
beforeEach(async () => {
  db = await freshDb();
});
const statusOf = async () => (await dynastyVersions(db, "message_written", "dy_w")).map((v) => `v${v.version}:${v.status}`);

describe("restoring an earlier script version", () => {
  it("puts v2 back live, parks v3 with the reason, and the next upgrade is v4", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_w", code: CODE, description: "Writer" }, author, deps as never);
    await upgradeScript(db, "message_written", "dy_w", { code: CODE.replace('"v1"', '"v2"') }, author);
    await upgradeScript(db, "message_written", "dy_w", { code: CODE.replace('"v1"', '"v3"') }, author);
    await restoreScriptVersion(db, "message_written", "dy_w", 2, "its pairs cannot be proven this month");
    expect(await statusOf()).toEqual(["v3:deprecated", "v2:active", "v1:deprecated"]);
    const parked = (await dynastyVersions(db, "message_written", "dy_w")).find((v) => v.version === 3)!;
    expect(parked.deprecationReason).toContain("version 2 restored (its pairs cannot be proven this month)");

    const v4 = await upgradeScript(db, "message_written", "dy_w", { code: CODE.replace('"v1"', '"v4"') }, author);
    expect(v4.version).toBe(4);
    expect(await statusOf()).toEqual(["v4:active", "v3:deprecated", "v2:deprecated", "v1:deprecated"]);
  });

  it("refuses an unknown version and the active one", async () => {
    await createScript(db, { outcome: "message_written", dynasty: "dy_w", code: CODE, description: "Writer" }, author, deps as never);
    const err = async (p: Promise<unknown>) => p.then(() => "ok", (e) => (e instanceof ScriptCatalogueError ? `${e.status} ${e.code}` : String(e)));
    expect(await err(restoreScriptVersion(db, "message_written", "dy_w", 9, "x"))).toBe("404 not_found");
    expect(await err(restoreScriptVersion(db, "message_written", "dy_w", 1, "x"))).toBe("409 already_active");
  });
});
