import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import {
  ScriptCatalogueError,
  createScript,
  dynastyVersions,
  forkScript,
  listScripts,
  summarizeScript,
  upgradeScript,
  type AnyPgDb,
} from "../../src/lib/scripts/script-catalogue.js";
import { rehomeScript } from "../../src/lib/scripts/script-rehome.js";
import {
  modelNamer,
  nameUnnamedScripts,
  readNameAnswer,
  renameDynasty,
  scriptNameMessage,
  scriptNameProblem,
  type NameDynasties,
} from "../../src/lib/scripts/script-names.js";
import { scripts } from "../../src/db/schema.js";

// CAMPAIGN-SCRIPTS-1113-NAMES: every script dynasty carries a short client-readable name, the same on every version,
// unique within its outcome, written at creation (stated, else the namer) and by the sweep for older dynasties.
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
  return { content: { said: String(ctx.tactics.word ?? "hi") } };
}`;
const CODE_2 = CODE.replace('"hi"', '"hello"');

/** A namer that names from the description and records what it was asked. */
function recordingNamer() {
  const asked: Array<{ outcome: string; dynasties: string[]; taken: string[] }> = [];
  const namer: NameDynasties = async (outcome, toName, taken) => {
    asked.push({ outcome, dynasties: toName.map((d) => d.dynasty), taken });
    return new Map(toName.map((d) => [d.dynasty, d.description]));
  };
  return { namer, asked };
}

const author = { orgId: "org-staff", createdBy: "staff@example.com" };
let db: AnyPgDb;
let rec: ReturnType<typeof recordingNamer>;
let deps: { isKnownOutcome: (o: string) => Promise<boolean>; nameDynasties: NameDynasties };

beforeEach(async () => {
  db = await freshDb();
  rec = recordingNamer();
  deps = { isKnownOutcome: async (o) => ["paid_client", "lead_interested", "conversation"].includes(o), nameDynasties: rec.namer };
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "ok";
  } catch (e) {
    return e instanceof ScriptCatalogueError ? `${e.status} ${e.code}` : String(e);
  }
}

describe("scriptNameProblem", () => {
  it("accepts a plain short name, refuses codes, versions, dashes, agency and long text", () => {
    expect(scriptNameProblem("Brand team assistant")).toBeNull();
    expect(scriptNameProblem("Follow-up when due")).toBeNull();
    expect(scriptNameProblem("dy_brand_team")).toMatch(/code character/);
    expect(scriptNameProblem("Dy brand team")).toMatch(/slug or a version/);
    expect(scriptNameProblem("Brand team v2")).toMatch(/slug or a version/);
    expect(scriptNameProblem("Brand team — assistant")).toMatch(/dash/);
    expect(scriptNameProblem("Brand team – assistant")).toMatch(/dash/);
    expect(scriptNameProblem("Agency follow-up")).toMatch(/agency/);
    expect(scriptNameProblem("x")).toMatch(/empty/);
    expect(scriptNameProblem("A very long name that a client cannot read at a glance")).toMatch(/longer/);
    expect(scriptNameProblem("email_sent/dy_x")).not.toBeNull();
  });
});

describe("names at creation", () => {
  it("a new dynasty gets the namer's name, told the Engine's taken names; an upgrade keeps it", async () => {
    const a = await createScript(db, { outcome: "paid_client", dynasty: "dy_brand_team", code: CODE, description: "Brand team assistant" }, author, deps);
    expect(a.name).toBe("Brand team assistant");
    const b = await createScript(db, { outcome: "paid_client", dynasty: "dy_check_in", code: CODE, description: "Client check-in" }, author, deps);
    expect(b.name).toBe("Client check-in");
    expect(rec.asked[1]).toEqual({ outcome: "paid_client", dynasties: ["dy_check_in"], taken: ["Brand team assistant"] });

    const v2 = await upgradeScript(db, "paid_client", "dy_brand_team", { code: CODE_2, description: "Changed text" }, author);
    expect(v2.name).toBe("Brand team assistant");
    expect((await dynastyVersions(db, "paid_client", "dy_brand_team")).map((v) => v.name)).toEqual(["Brand team assistant", "Brand team assistant"]);
  });

  it("a stated name is checked and must be free in the Engine; another Engine may reuse it", async () => {
    const a = await createScript(db, { outcome: "paid_client", dynasty: "dy_a", code: CODE, description: "x", name: "  Follow-up   when due " }, author, deps);
    expect(a.name).toBe("Follow-up when due");
    expect(rec.asked).toHaveLength(0);
    expect(await code(createScript(db, { outcome: "paid_client", dynasty: "dy_b", code: CODE, description: "x", name: "follow-up WHEN due" }, author, deps))).toBe("409 name_taken");
    expect(await code(createScript(db, { outcome: "paid_client", dynasty: "dy_c", code: CODE, description: "x", name: "dy_c" }, author, deps))).toBe("400 invalid_name");
    const other = await createScript(db, { outcome: "lead_interested", dynasty: "dy_b", code: CODE, description: "x", name: "Follow-up when due" }, author, deps);
    expect(other.name).toBe("Follow-up when due");
  });

  it("a fork gets its own name, never its source's", async () => {
    await createScript(db, { outcome: "paid_client", dynasty: "dy_a", code: CODE, description: "x", name: "Answer leads" }, author, deps);
    const f = await forkScript(db, "paid_client", "dy_a", { dynasty: "dy_a_gpt", description: "Answer leads with GPT Pro", tactics: { word: "yo" } }, author, deps);
    expect(f.name).toBe("Answer leads with GPT Pro");
    expect(rec.asked[0]!.taken).toEqual(["Answer leads"]);
    expect(await code(forkScript(db, "paid_client", "dy_a", { dynasty: "dy_a_2", description: "x", name: "Answer leads" }, author, deps))).toBe("409 name_taken");
  });

  it("a re-homed dynasty keeps its name unless the new outcome already serves it", async () => {
    await createScript(db, { outcome: "conversation", dynasty: "dy_due", code: CODE, description: "x", name: "Follow-up when due" }, author, deps);
    const out = await rehomeScript(db, "conversation", "dy_due", { toOutcome: "lead_interested" }, author, deps);
    expect(out.script.name).toBe("Follow-up when due");
    await createScript(db, { outcome: "conversation", dynasty: "dy_due2", code: CODE, description: "Second follow-up", name: "Follow-up again" }, author, deps);
    await createScript(db, { outcome: "lead_interested", dynasty: "dy_there", code: CODE, description: "x", name: "Follow-up again" }, author, deps);
    const out2 = await rehomeScript(db, "conversation", "dy_due2", { toOutcome: "lead_interested" }, author, deps);
    expect(out2.script.name).toBe("Second follow-up");
  });

  it("the served script carries its name", async () => {
    const a = await createScript(db, { outcome: "paid_client", dynasty: "dy_a", code: CODE, description: "x", name: "Answer leads" }, author, deps);
    expect(summarizeScript(a, 0).name).toBe("Answer leads");
  });

  it("rename moves every version, checked like a stated name", async () => {
    await createScript(db, { outcome: "paid_client", dynasty: "dy_a", code: CODE, description: "x", name: "Answer leads" }, author, deps);
    await createScript(db, { outcome: "paid_client", dynasty: "dy_b", code: CODE, description: "x", name: "Check in" }, author, deps);
    await upgradeScript(db, "paid_client", "dy_a", { code: CODE_2 }, author);
    expect(await renameDynasty(db, "paid_client", "dy_a", "Answer every lead")).toBe("Answer every lead");
    expect((await dynastyVersions(db, "paid_client", "dy_a")).map((v) => v.name)).toEqual(["Answer every lead", "Answer every lead"]);
    expect(await code(renameDynasty(db, "paid_client", "dy_a", "check in"))).toBe("409 name_taken");
    expect(await code(renameDynasty(db, "paid_client", "dy_a", "Answer leads"))).toBe("ok");
    expect(await code(renameDynasty(db, "paid_client", "dy_zz", "Nope here"))).toBe("404 not_found");
  });
});

describe("the sweep", () => {
  it("names every dynasty stored without a name, all its versions, unique per outcome", async () => {
    await createScript(db, { outcome: "paid_client", dynasty: "dy_named", code: CODE, description: "x", name: "Already named" }, author, deps);
    for (const d of ["dy_one", "dy_two"]) {
      await createScript(db, { outcome: "paid_client", dynasty: d, code: CODE, description: d, name: `Temp ${d.slice(3)}` }, author, deps);
    }
    await upgradeScript(db, "paid_client", "dy_one", { code: CODE_2 }, author);
    // Rows stored before names existed.
    await db.update(scripts).set({ name: null }).where(eq(scripts.dynasty, "dy_one"));
    await db.update(scripts).set({ name: null }).where(eq(scripts.dynasty, "dy_two"));

    let n = 0;
    const namer: NameDynasties = async (_o, toName, taken) => {
      expect(taken).toEqual(["Already named"]);
      return new Map(toName.map((d) => [d.dynasty, `Swept name ${++n === 1 ? "one" : "two"}`]));
    };
    expect(await nameUnnamedScripts(db, namer)).toEqual({ named: 2, failed: [] });
    const all = await listScripts(db, { status: "all" });
    expect(all.every((r) => r.name)).toBe(true);
    expect((await dynastyVersions(db, "paid_client", "dy_one")).map((v) => v.name)).toEqual(["Swept name one", "Swept name one"]);
    expect(await nameUnnamedScripts(db, namer)).toEqual({ named: 0, failed: [] });
  });

  it("a namer failure is logged per outcome and leaves the rows for the next sweep", async () => {
    await createScript(db, { outcome: "paid_client", dynasty: "dy_one", code: CODE, description: "x", name: "Temp" }, author, deps);
    await db.update(scripts).set({ name: null });
    const out = await nameUnnamedScripts(db, async () => {
      throw new Error("chat down");
    });
    expect(out).toEqual({ named: 0, failed: ["paid_client"] });
    expect((await listScripts(db, { status: "all" }))[0]!.name).toBeNull();
  });
});

describe("the model namer", () => {
  const toName = [
    { dynasty: "dy_a", description: "Answers leads", tactics: { llm: { provider: "openai", model: "gpt-pro" }, systemPrompt: "x".repeat(5000) } },
    { dynasty: "dy_b", description: "Checks in clients", tactics: {} },
  ];

  it("the message names the Engine, the taken names and each script, long prompts clipped", () => {
    const m = scriptNameMessage("paid_client", toName, ["Brand team assistant"]);
    expect(m).toContain("Engine (the result these scripts make): paid client");
    expect(m).toContain('"Brand team assistant"');
    expect(m).toContain("id: dy_a");
    expect(m.length).toBeLessThan(2500);
  });

  it("refuses a bad, taken, duplicated or missing name", () => {
    expect(readNameAnswer({ names: [{ dynasty: "dy_a", name: "dy_a" }, { dynasty: "dy_b", name: "Check in" }] }, toName, [])).toEqual({ problem: expect.stringMatching(/code character/) });
    expect(readNameAnswer({ names: [{ dynasty: "dy_a", name: "Check in" }, { dynasty: "dy_b", name: "Other" }] }, toName, ["check in"])).toEqual({ problem: expect.stringMatching(/already taken/) });
    expect(readNameAnswer({ names: [{ dynasty: "dy_a", name: "Same" }, { dynasty: "dy_b", name: "same" }] }, toName, [])).toEqual({ problem: expect.stringMatching(/two scripts/) });
    expect(readNameAnswer({ names: [{ dynasty: "dy_a", name: "Answer leads" }] }, toName, [])).toEqual({ problem: "no name for dy_b" });
    const ok = readNameAnswer({ names: [{ dynasty: "dy_a", name: "Answer leads" }, { dynasty: "dy_b", name: "Client check-in" }] }, toName, []);
    expect("names" in ok && [...ok.names.entries()]).toEqual([["dy_a", "Answer leads"], ["dy_b", "Client check-in"]]);
  });

  it("asks again with the reason, then fails loud after three tries", async () => {
    const messages: string[] = [];
    const answers = [{ names: [] }, { names: [{ dynasty: "dy_a", name: "Answer leads" }, { dynasty: "dy_b", name: "Client check-in" }] }];
    const namer = modelNamer(async (_s, m) => {
      messages.push(m);
      return answers.shift();
    });
    expect([...(await namer("paid_client", toName, [])).values()]).toEqual(["Answer leads", "Client check-in"]);
    expect(messages[1]).toMatch(/previous answer was refused: no name for dy_a, dy_b/);
    const never = modelNamer(async () => ({ names: [] }));
    await expect(never("paid_client", toName, [])).rejects.toThrow(/after 3 tries/);
  });
});
