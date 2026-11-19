import { testNamer } from "../helpers/script-names.js";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { createScript, type AnyPgDb } from "../../src/lib/scripts/script-catalogue.js";
import {
  needsOfAsk,
  pickScript,
  productionLlmServing,
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

describe("productionLlmServing (chat-service GET /internal/local-llm/served-llms)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const setEnv = () => {
    process.env.CHAT_SERVICE_URL = "http://chat.test/";
    process.env.CHAT_SERVICE_API_KEY = "chat-key";
  };

  it("asks once for the org and every stated LLM, reads runsAsStated (null = not served = not drawn)", async () => {
    setEnv();
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      expect(init.headers["x-api-key"]).toBe("chat-key");
      return new Response(
        JSON.stringify({
          orgId: LOCAL_ORG,
          local: true,
          llms: [
            { llm: "anthropic/claude-sonnet", runsAsStated: true },
            { llm: "deepseek/deepseek-flash", runsAsStated: false },
            { llm: "nope/x", runsAsStated: null, error: "unknown" },
          ],
        }),
        { status: 200 },
      );
    });
    const m = await productionLlmServing(LOCAL_ORG, [
      { provider: "anthropic", model: "claude-sonnet" },
      { provider: "deepseek", model: "deepseek-flash" },
      { provider: "nope", model: "x" },
    ]);
    expect(urls).toEqual([`http://chat.test/internal/local-llm/served-llms?orgId=${LOCAL_ORG}&llms=${encodeURIComponent("anthropic/claude-sonnet,deepseek/deepseek-flash,nope/x")}`]);
    expect([...m.entries()]).toEqual([
      ["anthropic/claude-sonnet", true],
      ["deepseek/deepseek-flash", false],
      ["nope/x", false],
    ]);
  });

  it("a non-2xx throws (fail closed)", async () => {
    setEnv();
    vi.stubGlobal("fetch", async () => new Response("down", { status: 502 }));
    await expect(productionLlmServing(LOCAL_ORG, [{ provider: "anthropic", model: "claude-sonnet" }])).rejects.toThrow("chat-service 502");
  });
});

// WEBSEARCH-PICK-1119: the social post scripts ask llm_completion for a web-search angle read; the Rating drew DeepSeek /
// GLM / Kimi / GPT completion scripts, whose direct-vendor path refuses web search: every such run 400'd.
describe("a script is drawn only where its model takes what the ask needs", () => {
  it("needsOfAsk reads the asked request's own webSearch / imageUrl", () => {
    expect(needsOfAsk({ units: {}, request: { message: "m", webSearch: true } })).toEqual({ webSearch: true });
    expect(needsOfAsk({ units: {}, request: { message: "m", imageUrl: "https://x/i.png" } })).toEqual({ imageUrl: true });
    expect(needsOfAsk({ units: {}, request: { message: "m", webSearch: false, imageUrl: "" } })).toEqual({});
    expect(needsOfAsk({ units: {} })).toEqual({});
  });

  it("a web-search ask keeps only the scripts whose model searches; the reader is told the need", async () => {
    const asked: unknown[] = [];
    setLlmServingReader(async (_org, llms, needs) => {
      asked.push(needs);
      return new Map(llms.map((l) => [`${l.provider}/${l.model}`, !(needs?.webSearch && l.provider === "deepseek")]));
    });
    const p = await pickScript(db, { outcome: "x_post_published", servable: [], channel: "x-post", campaignId: "camp-1", orgId: VENDOR_ORG, needs: { webSearch: true } });
    expect(p?.ranked.map((r) => r.dynasty)).toEqual(["dy_x_post__claude_sonnet"]);
    expect(asked).toEqual([{ webSearch: true }]);
  });

  it("an ask with no need is unchanged (the reader is asked nothing more)", async () => {
    const asked: unknown[] = [];
    setLlmServingReader(async (_org, llms, needs) => {
      asked.push(needs);
      return new Map(llms.map((l) => [`${l.provider}/${l.model}`, true]));
    });
    const p = await pickScript(db, { outcome: "x_post_published", servable: [], channel: "x-post", campaignId: "camp-1", orgId: VENDOR_ORG, needs: {} });
    expect(p?.ranked).toHaveLength(2);
    expect(asked).toEqual([undefined]);
  });

  it("a need with no org cannot be judged: throws", async () => {
    await expect(pickScript(db, { outcome: "x_post_published", servable: [], channel: "x-post", campaignId: "camp-1", orgId: null, needs: { webSearch: true } })).rejects.toThrow(/names no org/);
  });

  it("production reader sends webSearch=true and keeps only rows that run as stated AND accept the request", async () => {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "chat-key";
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          orgId: VENDOR_ORG,
          local: false,
          llms: [
            { llm: "anthropic/claude-sonnet", runsAsStated: true, acceptsRequest: true },
            { llm: "deepseek/deepseek-flash", runsAsStated: true, acceptsRequest: false },
          ],
        }),
        { status: 200 },
      );
    });
    const m = await productionLlmServing(VENDOR_ORG, [{ provider: "anthropic", model: "claude-sonnet" }, { provider: "deepseek", model: "deepseek-flash" }], { webSearch: true });
    expect(urls[0]).toContain("&webSearch=true");
    expect([...m.entries()]).toEqual([["anthropic/claude-sonnet", true], ["deepseek/deepseek-flash", false]]);
    vi.unstubAllGlobals();
  });

  it("production reader fails loud when a need was asked and chat-service answers no acceptsRequest", async () => {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "chat-key";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ orgId: VENDOR_ORG, local: false, llms: [{ llm: "deepseek/deepseek-flash", runsAsStated: true }] }), { status: 200 }));
    await expect(productionLlmServing(VENDOR_ORG, [{ provider: "deepseek", model: "deepseek-flash" }], { webSearch: true })).rejects.toThrow(/no acceptsRequest/);
    vi.unstubAllGlobals();
  });
});
