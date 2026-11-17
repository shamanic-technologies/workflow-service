import { describe, expect, it } from "vitest";
import { callVendor, type VendorDeps } from "../../src/lib/scripts/vendors.js";
import { dagToOpenFlow, personThreadQueryExpr, readsPersonThread } from "../../src/lib/dag-to-openflow.js";
import { evalAsWindmill } from "../../src/lib/windmill-expr.js";
import { PERSON_THREAD_DEFAULT_QUERY } from "../../src/lib/person-thread-query.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../scripts/engine-ports/follow-up-steps.js";
import { buildClientCheckInDag } from "../../scripts/engine-ports/client-check-in-steps.js";
import type { DAG } from "../../src/lib/dag-validator.js";

/**
 * UNIBOX-API-LOGS-1117 (prod 2026-11-17): Kevin's own Unibox thread held 34,655 items (26 MB), 28,952 of them logs of
 * calls agent sessions made to our API and MCP with his staff key. A script's sandbox holds 64 MB, so every
 * « Assistant for brand team » run crashed reading his thread (18 that day) and Ethan's $10 payment link was never
 * sent. Every person-thread read now asks crm-service to leave the `api` source out.
 */
const RUN = { "x-org-id": "org-1", "x-user-id": "user-1", "x-run-id": "script-run", "x-brand-id": "brand-1", "x-campaign-id": "camp-1" };
const ctx = { headers: RUN, tactics: {} };

function door() {
  const seen: string[] = [];
  const deps = {
    async serviceDoor(_s: string, _m: string, path: string) {
      seen.push(path);
      return { status: 200, body: { items: [] } };
    },
    async sleep() {},
  } as unknown as VendorDeps;
  return { seen, deps };
}

describe("a script's person-thread read leaves out the API/MCP call logs", () => {
  it("the door adds excludeSources=api to the script's own query", async () => {
    const { seen, deps } = door();
    await callVendor("crm.person.thread", { query: { personKey: "email:kevin@distribute.you" } }, ctx, deps);
    const q = new URLSearchParams(seen[0]!.split("?")[1]);
    expect(q.get("excludeSources")).toBe("api");
    expect(q.get("personKey")).toBe("email:kevin@distribute.you");
  });

  it("a call stating excludeSources keeps its own value", async () => {
    const { seen, deps } = door();
    await callVendor("crm.person.thread", { query: { personKey: "k", excludeSources: "api,matrix" } }, ctx, deps);
    expect(new URLSearchParams(seen[0]!.split("?")[1]).getAll("excludeSources")).toEqual(["api,matrix"]);
  });

  it("no other door gets it", async () => {
    const { seen, deps } = door();
    await callVendor("crm.whatsapp.sent", { query: { email: "a@b.co" } }, ctx, deps);
    expect(seen[0]).not.toContain("excludeSources");
  });
});

describe("a workflow's person-thread read leaves them out too (conversion time)", () => {
  it("the query expression adds the default to a stated query, keeps a stated key, and fills a missing query", () => {
    expect(evalAsWindmill(personThreadQueryExpr(`({ personKey: "email:a@b.co" })`), {})).toEqual({ excludeSources: "api", personKey: "email:a@b.co" });
    expect(evalAsWindmill(personThreadQueryExpr(`({ excludeSources: "matrix" })`), {})).toEqual({ excludeSources: "matrix" });
    expect(evalAsWindmill(personThreadQueryExpr("undefined"), {})).toEqual({ ...PERSON_THREAD_DEFAULT_QUERY });
  });

  type Mod = { id: string; value: { input_transforms?: Record<string, { type: string; expr?: string }>; branches?: { modules: Mod[] }[]; default?: Mod[]; modules?: Mod[] } };
  const all = (mods: Mod[]): Mod[] =>
    mods.flatMap((m) => [m, ...all(m.value.modules ?? []), ...(m.value.branches ?? []).flatMap((b) => all(b.modules)), ...all(m.value.default ?? [])]);
  const WRITERS: Record<string, DAG> = {
    "cold-whatsapp-outreach": buildColdWhatsappOutreachDag(),
    "follow-up-proactive": buildFollowUpProactiveDag(),
    "follow-up-reactive": buildFollowUpReactiveDag({ readFigures: false }),
    "client-check-in": buildClientCheckInDag(),
  };
  for (const [name, dag] of Object.entries(WRITERS)) {
    it(name, () => {
      const ids = new Set(dag.nodes.filter(readsPersonThread).map((n) => n.id.replace(/-/g, "_")));
      expect(ids.size).toBeGreaterThan(0);
      const mods = all((dagToOpenFlow(dag, name) as unknown as { value: { modules: Mod[] } }).value.modules);
      for (const id of ids) {
        const t = mods.find((m) => m.id === id)!.value.input_transforms!.query!;
        expect(t.type).toBe("javascript");
        expect(t.expr).toContain(`"excludeSources":"api"`);
      }
      for (const m of mods.filter((m) => !ids.has(m.id))) expect(m.value.input_transforms?.query?.expr ?? "", m.id).not.toContain("excludeSources");
    });
  }
});
