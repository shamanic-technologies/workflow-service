import { testNamer } from "../helpers/script-names.js";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import {
  pickScript,
  runsAsStated,
  setLlmServingReader,
  setScriptPickReader,
  setScriptStrategyReader,
  statedLlmsOf,
  type StatedLlm,
} from "../../src/lib/scripts/engine.js";
import { fakeScriptPick } from "../helpers/script-pick.js";
import { scripts } from "../../src/db/schema.js";

// LOCAL-CLAUDE-RATING-1116: a script is drawn only where the LLM it states runs AS STATED for the run's org. An org on
// local Claude runs a non-Claude LLM as Claude, so a script named after that LLM would be credited for Claude's work.
const MIGRATIONS = join(__dirname, "../../drizzle");
async function freshDb() {
  const client = new PGlite();
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
    for (const stmt of readFileSync(join(MIGRATIONS, f), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await client.exec(stmt);
  }
  return drizzle(client) as unknown as AnyPgDb;
}

const POST = `
export default function run(ctx) {
  return { content: { posted: true } };
}`;
const author = { orgId: "org-staff", createdBy: "staff@example.com" };
const known = { isKnownOutcome: async () => true, nameDynasties: testNamer() };
const DEEPSEEK = { provider: "deepseek", model: "deepseek-flash", name: "DeepSeek Flash" };
const SONNET = { provider: "anthropic", model: "claude-sonnet", name: "Claude Sonnet" };
const LOCAL_ORG = "org-local";
const VENDOR_ORG = "org-vendor";

/** chat-service stand-in: the local org runs only Claude as stated; every other org runs every LLM as stated. */
function serving() {
  const asked: Array<{ orgId: string; llms: StatedLlm[] }> = [];
  const reader = async (orgId: string, llms: StatedLlm[]) => {
    asked.push({ orgId, llms });
    return new Map(llms.map((l) => [`${l.provider}/${l.model}`, orgId !== LOCAL_ORG || l.provider === "anthropic"]));
  };
  return Object.assign(reader, { asked });
}

let db: AnyPgDb;
async function add(dynasty: string, tactics: Record<string, unknown>) {
  const row = await createScript(db, { outcome: "x_post_published", dynasty, code: POST, description: "x" }, author, known);
  await db.update(scripts).set({ tactics }).where(eq(scripts.id, row.id));
}
const pick = (orgId: string | null) => pickScript(db, { outcome: "x_post_published", servable: [], channel: "x-post", campaignId: "camp-1", orgId });

beforeEach(async () => {
  db = await freshDb();
  setScriptPickReader(fakeScriptPick());
  setScriptStrategyReader(async (_c, outcome) => (await db.select().from(scripts).where(eq(scripts.outcome, outcome))).map((r) => r.dynasty));
  await add("dy_x_post__deepseek_flash", { llm: DEEPSEEK, channel: "x-post" });
  await add("dy_x_post__claude_sonnet", { llm: SONNET, channel: "x-post" });
}, 60_000);
afterEach(() => setLlmServingReader(null));

describe("a script is drawn only where its stated LLM runs as stated", () => {
  it("an org on local Claude is served only the Claude-stated script", async () => {
    const s = serving();
    setLlmServingReader(s);
    const p = await pick(LOCAL_ORG);
    expect(p?.ranked.map((r) => r.dynasty)).toEqual(["dy_x_post__claude_sonnet"]);
    // ONE read per pick, every distinct stated LLM in it.
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]!.llms.map((l) => `${l.provider}/${l.model}`).sort()).toEqual(["anthropic/claude-sonnet", "deepseek/deepseek-flash"]);
  });

  it("an org running every LLM as stated keeps every script (the pick is unchanged)", async () => {
    setLlmServingReader(serving());
    const p = await pick(VENDOR_ORG);
    expect(p?.ranked.map((r) => r.dynasty).sort()).toEqual(["dy_x_post__claude_sonnet", "dy_x_post__deepseek_flash"]);
  });

  it("a run naming no org asks nothing and narrows nothing", async () => {
    const s = serving();
    setLlmServingReader(s);
    const p = await pick(null);
    expect(p?.ranked).toHaveLength(2);
    expect(s.asked).toHaveLength(0);
  });

  it("no Claude-stated script = nothing to run for the local org (idle), never a script another model would write", async () => {
    await db.delete(scripts).where(eq(scripts.dynasty, "dy_x_post__claude_sonnet"));
    setLlmServingReader(serving());
    expect(await pick(LOCAL_ORG)).toBeNull();
  });

  it("an unreadable serving answer throws: the run picks nothing and is retried", async () => {
    setLlmServingReader(async () => {
      throw new Error("chat-service 502");
    });
    await expect(pick(LOCAL_ORG)).rejects.toThrow("chat-service 502");
  });

  it("a script stating no LLM is kept and not asked about", async () => {
    await add("dy_x_post_no_llm", { channel: "x-post" });
    const s = serving();
    setLlmServingReader(s);
    const p = await pick(LOCAL_ORG);
    expect(p?.ranked.map((r) => r.dynasty).sort()).toEqual(["dy_x_post__claude_sonnet", "dy_x_post_no_llm"]);
  });
});

describe("statedLlmsOf / runsAsStated (pure)", () => {
  it("reads `llm` and every `llms[place]`, deduped", () => {
    expect(statedLlmsOf({ llm: SONNET, llms: { writer: DEEPSEEK, research: SONNET } })).toEqual([
      { provider: "anthropic", model: "claude-sonnet" },
      { provider: "deepseek", model: "deepseek-flash" },
    ]);
    expect(statedLlmsOf({})).toEqual([]);
  });

  it("drops a script when ANY of its stated LLMs would run as another model", () => {
    const served = new Map([
      ["anthropic/claude-sonnet", true],
      ["deepseek/deepseek-flash", false],
    ]);
    const rows = [{ tactics: { llms: { writer: SONNET, research: DEEPSEEK } } }, { tactics: { llm: SONNET } }];
    expect(runsAsStated(rows, served)).toEqual([rows[1]]);
  });

  it("an LLM the answer does not name throws (never read as served)", () => {
    expect(() => runsAsStated([{ tactics: { llm: SONNET } }], new Map())).toThrow("anthropic/claude-sonnet");
  });
});
