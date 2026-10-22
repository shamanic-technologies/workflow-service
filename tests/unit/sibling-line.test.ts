import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  linesFromAnswer,
  lineFacts,
  siblingGroups,
  siblingLineProblem,
  siblingLineSystemPrompt,
  starName,
  type PipeMember,
} from "../../src/lib/sibling-line.js";
import { pageWords, readSiblingLines, singleSiblingLine, sweepSiblingLines, type SiblingLineDeps } from "../../src/lib/sibling-line-refresher.js";
import type { LegAssignment } from "../../src/lib/catalogue-client.js";

const gen = (variables: Record<string, string>, extra: Record<string, unknown> = {}) => ({
  nodes: [
    { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" } },
    {
      id: "email-generate",
      type: "http.call",
      config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v39", model: "opus", ...extra } },
      inputMapping: Object.fromEntries(Object.entries(variables).map(([k, v]) => [`body.variables.${k}`, v])),
    },
  ],
  edges: [{ from: "fetch-lead", to: "email-generate" }],
});

const member = (name: string, dag: unknown): PipeMember => ({
  workflowDynastySlug: `sales-cold-email-outreach-${name.toLowerCase()}`,
  displayName: name,
  dag: dag as PipeMember["dag"],
});

describe("sibling lines: the facts a line may state", () => {
  it("ignores the steps that pick the writer each run", () => {
    const pinned = gen({ leadFirstName: "$ref:fetch-lead.output.lead.firstName" });
    const freed = gen({ leadFirstName: "$ref:fetch-lead.output.lead.firstName", type: "$ref:writer-plan.output.type" });
    freed.nodes.push({ id: "writer-pick", type: "http.call", config: { service: "features", method: "GET", path: "/internal/writer-pick" } } as never);
    freed.edges.push({ from: "writer-pick", to: "email-generate" });
    expect(lineFacts(freed as never)).toEqual(lineFacts(pinned as never));
  });

  it("ignores the template and LLM a call pins, so two workflows differing only by them are twins", () => {
    const a = gen({ leadFirstName: "$ref:fetch-lead.output.lead.firstName" });
    const b = { ...gen({ leadFirstName: "$ref:fetch-lead.output.lead.firstName" }) };
    (b.nodes[1].config.body as Record<string, unknown>).type = "cold-email-v40";
    (b.nodes[1].config.body as Record<string, unknown>).model = "sonnet";
    expect(lineFacts(a as never)).toEqual(lineFacts(b as never));
    const groups = siblingGroups([member("Keel", a), member("Acrux", b)]);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((m) => m.displayName)).toEqual(["Acrux", "Keel"]);
  });

  it("keeps only what not every group holds", () => {
    const base = gen({ leadFirstName: "$ref:fetch-lead.output.lead.firstName" });
    const withBrand = gen({ leadFirstName: "$ref:fetch-lead.output.lead.firstName", brandName: "$ref:brand.output.name" });
    const groups = siblingGroups([member("Keel", base), member("Tectonic", withBrand)]);
    expect(groups.map((g) => g.own)).toEqual([[], ["email-generate body.variables.brandName <- $ref:brand.output.name"]]);
  });

  it("reads the star out of the dynasty name", () => {
    expect(starName("Sales Cold Email Outreach Keel", "sales-cold-email-outreach")).toBe("Keel");
    expect(starName("Sales Cold Email Outreach Bright Vega", "sales-cold-email-outreach")).toBe("Bright Vega");
  });
});

describe("sibling lines: the rules a line obeys", () => {
  const banned = ["Dotterel", "Cold Email", "Lead found", "Positive reply"];
  it("refuses dashes, pipe words, the page's own names, writer names and long lines", () => {
    expect(siblingLineProblem("Brand name + website link", 10, banned)).toBeNull();
    expect(siblingLineProblem("Brand name — website link", 10, banned)).toMatch(/dash/);
    expect(siblingLineProblem("Only on this leg", 10, banned)).toMatch(/leg/);
    expect(siblingLineProblem("Dotterel with brand name", 10, banned)).toMatch(/Dotterel/);
    expect(siblingLineProblem("Cold email with brand name", 10, banned)).toMatch(/Cold Email/);
    expect(siblingLineProblem("Writes with Opus", 10, banned)).toMatch(/opus/i);
    expect(siblingLineProblem("Uses another template", 10, banned)).toMatch(/template/);
    expect(siblingLineProblem("one two three four five six seven eight nine ten eleven", 10, banned)).toMatch(/11 words/);
  });

  it("bans the pipe's name, the channel's name and every word pair of it", () => {
    const words = pageWords("Dotterel", "Sales Cold Email Outreach");
    expect(words).toEqual(["Dotterel", "Sales Cold Email Outreach", "Sales Cold", "Cold Email", "Email Outreach"]);
    expect(siblingLineProblem("Cold email with brand name", 10, words)).toMatch(/Cold Email/);
  });

  it("the system prompt states no dash itself", () => {
    expect(siblingLineSystemPrompt()).not.toMatch(/[–—]/);
  });

  const groups = siblingGroups([
    member("Keel", gen({ a: "$ref:x.output.a" })),
    member("Tectonic", gen({ b: "$ref:x.output.b" })),
    member("Alioth", gen({ c: "$ref:x.output.c" })),
    member("Rudder", gen({ c: "$ref:x.output.c" }, { model: "sonnet" })),
    member("Delphi", gen({ c: "$ref:x.output.c" }, { type: "other" })),
  ]);

  it("gives every member its own line; twins read apart and say they run the same steps", () => {
    const keys = Object.fromEntries(groups.map((g) => [g.members[0].displayName, g.key]));
    const r = linesFromAnswer(
      groups,
      { lines: [
        { group: keys.Keel, line: "Lead first name only." },
        { group: keys.Tectonic, line: "Adds company keywords" },
        { group: keys.Alioth, line: "Adds today's date" },
      ] },
      banned,
    );
    expect("lines" in r).toBe(true);
    const lines = (r as { lines: Map<string, string> }).lines;
    expect(lines.get("sales-cold-email-outreach-keel")).toBe("Lead first name only");
    expect(lines.get("sales-cold-email-outreach-alioth")).toBe("Adds today's date, same steps as Delphi");
    expect(lines.get("sales-cold-email-outreach-delphi")).toBe("Adds today's date, same steps as Rudder");
    expect(lines.get("sales-cold-email-outreach-rudder")).toBe("Adds today's date, same steps as Alioth");
    const all = [...lines.values()];
    expect(new Set(all).size).toBe(5);
    for (const l of all) expect(l.split(/\s+/).length).toBeLessThanOrEqual(10);
  });

  it("sends back a missing group, a repeated line or a twin line too long", () => {
    const keys = groups.map((g) => g.key);
    const missing = linesFromAnswer(groups, { lines: [{ group: keys[0], line: "A" + "b" }] }, banned);
    expect(missing).toMatchObject({ problem: expect.stringMatching(/missing/) });
    const same = linesFromAnswer(groups, { lines: keys.map((k) => ({ group: k, line: "Brand name" })) }, banned);
    expect(same).toMatchObject({ problem: expect.stringMatching(/repeat/) });
    const twin = groups.find((g) => g.members.length > 1)!;
    const long = linesFromAnswer(
      groups,
      { lines: keys.map((k, i) => ({ group: k, line: k === twin.key ? "one two three four five six" : `Line ${i}` })) },
      banned,
    );
    expect(long).toMatchObject({ problem: expect.stringMatching(/at most 5/) });
  });
});

// ─── The sweep, on a real Postgres with the service's own migrations ───

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

describe("sibling lines: the sweep", () => {
  let client: PGlite;
  let db: ReturnType<typeof drizzle>;
  let assignments: LegAssignment[];
  let calls: number;
  let answer: (message: string) => unknown;

  const FEATURE = "sales-cold-email-outreach";
  const deps = (): SiblingLineDeps => ({
    listAssignments: async () => assignments,
    pipeWords: async () => ["Dotterel", "Sales Cold Email Outreach"],
    complete: async (_system, message) => {
      calls++;
      return answer(message);
    },
  });

  async function insert(star: string, version: number, dag: unknown, signature: string) {
    const dyn = `${FEATURE}-${star.toLowerCase()}`;
    await client.query(
      `INSERT INTO workflows (org_id, workflow_slug, workflow_name, workflow_dynasty_slug, workflow_dynasty_name, feature_slug,
         signature, workflow_dynasty_signature_name, version, dag, status)
       VALUES ('org', $1, $1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active')`,
      [version === 1 ? dyn : `${dyn}-v${version}`, dyn, `Sales Cold Email Outreach ${star}`, FEATURE, signature, star.toLowerCase(), version, JSON.stringify(dag)],
    );
  }
  const assign = (star: string, legKey = "lead_found_to_conversation", state: "active" | "deprecated" = "active"): LegAssignment => ({
    featureSlug: FEATURE, legKey, workflowDynastySlug: `${FEATURE}-${star.toLowerCase()}`, state, decidedBy: "test", decidedAt: "2026-10-23T00:00:00Z", note: null,
  });
  const linesByGroup = (message: string) => ({
    lines: [...message.matchAll(/^## (G\d+)[^:]*: (.*)$/gm)].map((m) => ({ group: m[1], line: `Facts of ${m[2].split(",")[0]}` })),
  });

  beforeEach(async () => {
    ({ client, db } = await freshDb());
    calls = 0;
    answer = linesByGroup;
    await insert("Keel", 1, gen({ a: "$ref:x.output.a" }), "k1");
    await insert("Tectonic", 1, gen({ b: "$ref:x.output.b" }), "t1");
    await insert("Ballad", 1, gen({ c: "$ref:x.output.c" }), "b1");
    assignments = [assign("Keel"), assign("Tectonic"), assign("Ballad", "lead_found_to_conversation", "deprecated"), assign("Keel", "lead_found_to_website_visit")];
  }, 60_000);

  it("writes one distinct line per sibling, deprecated ones included, and none for a pipe with one workflow", async () => {
    const r = await sweepSiblingLines(db as never, deps());
    expect(r).toMatchObject({ written: 1, single: 1, failed: [] });
    const lines = await readSiblingLines(db as never, [`${FEATURE}-keel`, `${FEATURE}-tectonic`, `${FEATURE}-ballad`]);
    expect(lines.get(`${FEATURE}-keel`)).toEqual([{ legKey: "lead_found_to_conversation", line: "Facts of Keel" }]);
    expect(lines.get(`${FEATURE}-ballad`)).toEqual([{ legKey: "lead_found_to_conversation", line: "Facts of Ballad" }]);
    expect(singleSiblingLine(lines.get(`${FEATURE}-tectonic`))).toBe("Facts of Tectonic");
  });

  it("asks nothing when no sibling changed, and writes the pipe again when one is born or upgraded", async () => {
    await sweepSiblingLines(db as never, deps());
    expect(calls).toBe(1);
    await sweepSiblingLines(db as never, deps());
    expect(calls).toBe(1);

    await insert("Acrux", 1, gen({ d: "$ref:x.output.d" }), "a1");
    assignments.push(assign("Acrux"));
    await sweepSiblingLines(db as never, deps());
    expect(calls).toBe(2);
    expect((await readSiblingLines(db as never, [`${FEATURE}-acrux`])).get(`${FEATURE}-acrux`)?.[0].line).toBe("Facts of Acrux");

    await client.query(`UPDATE workflows SET status = 'deprecated' WHERE workflow_dynasty_slug = $1`, [`${FEATURE}-keel`]);
    await insert("Keel", 2, gen({ e: "$ref:x.output.e" }), "k2");
    await sweepSiblingLines(db as never, deps());
    expect(calls).toBe(3);
  });

  it("serves no line (never a stale one) when the model cannot write the pipe, and does not retry it at once", async () => {
    await sweepSiblingLines(db as never, deps());
    await insert("Acrux", 1, gen({ d: "$ref:x.output.d" }), "a1");
    assignments.push(assign("Acrux"));
    answer = () => ({ lines: [] });
    const r = await sweepSiblingLines(db as never, deps());
    expect(r.failed).toHaveLength(1);
    expect(calls).toBe(1 + 3);
    expect((await readSiblingLines(db as never, [`${FEATURE}-keel`])).size).toBe(0);
    await sweepSiblingLines(db as never, deps());
    expect(calls).toBe(4);
  });

  it("sets the running workflows apart from each other first, then every retired one apart from the whole pipe", async () => {
    await client.query(`UPDATE workflows SET workflow_dynasty_status = 'deprecated', status = 'deprecated' WHERE workflow_dynasty_slug = $1`, [`${FEATURE}-ballad`]);
    const messages: string[] = [];
    answer = (message) => {
      messages.push(message);
      return linesByGroup(message);
    };
    const r = await sweepSiblingLines(db as never, deps());
    expect(r.failed).toEqual([]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).not.toContain("Ballad");
    expect(messages[0]).toContain("Keel");
    expect(messages[1]).toContain("Lines already shown for the RUNNING workflows");
    expect(messages[1]).toContain("- Facts of Keel");
    expect(messages[1]).toMatch(/^## G\d+: Ballad$/m);
    const lines = await readSiblingLines(db as never, [`${FEATURE}-ballad`]);
    expect(lines.get(`${FEATURE}-ballad`)?.[0].line).toBe("Facts of Ballad");

    // Retiring a running one moves the key: the pipe is written again.
    await client.query(`UPDATE workflows SET workflow_dynasty_status = 'deprecated', status = 'deprecated' WHERE workflow_dynasty_slug = $1`, [`${FEATURE}-tectonic`]);
    await sweepSiblingLines(db as never, deps());
    expect(messages.length).toBeGreaterThan(2);
  });

  it("drops a pipe's lines once none of our workflows sits on it", async () => {
    await sweepSiblingLines(db as never, deps());
    assignments = [assign("Keel")];
    await sweepSiblingLines(db as never, deps());
    expect((await readSiblingLines(db as never, [`${FEATURE}-tectonic`])).size).toBe(0);
  });
});
