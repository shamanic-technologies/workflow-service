import { describe, it, expect } from "vitest";
import {
  FRESH_CONTACTS_FEATURE_SLUGS,
  FRESH_CONTACTS_MARKER,
  freshContactsApplies,
  freshContactsDescription,
  statesFreshContacts,
  withFreshContacts,
} from "../../src/lib/fresh-contacts.js";
import {
  CONTACTED_PROSPECTS_CHANGES,
  SOURCING_DESCRIPTION,
  buildSourcingDag,
  buildSourcingDagFor,
  sourcingDescriptionOf,
  sourcingTargetOf,
} from "../../src/lib/sourcing-dag.js";
import { applyDagPatch } from "../../src/lib/dag-patch.js";
import type { DAG } from "../../src/lib/dag-validator.js";

const serveBody = (dag: DAG) =>
  (dag.nodes.find((n) => (n.config as { path?: string } | undefined)?.path === "/orgs/buffer/next")!.config as { body?: Record<string, unknown> }).body;

const coldEmail = (): DAG => ({
  nodes: [
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next", body: { acceptedEmails: "valid_and_catch_all" } } },
    { id: "gen", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate" } },
  ],
  edges: [{ from: "start-run", to: "fetch-lead" }, { from: "fetch-lead", to: "gen" }],
});

describe("tactic Fresh contacts only (FRESH-CONTACTS-WF-1015)", () => {
  it("covers the cold channels only, never CRM contacts, follow-ups or Email Sending", () => {
    expect([...FRESH_CONTACTS_FEATURE_SLUGS]).toEqual([
      "sales-cold-email-outreach",
      "lead-sourcing",
      "sourcing-apollo-cold-filters",
      "sourcing-apollo-buying-signals",
      "sourcing-linkedin-engagement-signals",
    ]);
    for (const excluded of ["sourcing-crm-contacts", "email-sending", "ai-follow-up-email", "cold-whatsapp-outreach", "sales-crm-email-outreach"]) {
      expect(FRESH_CONTACTS_FEATURE_SLUGS as readonly string[]).not.toContain(excluded);
    }
  });

  it("a cold serve gains the window and keeps the body it states; the source is not mutated", () => {
    const src = coldEmail();
    const out = withFreshContacts(src);
    expect(serveBody(out)).toEqual({ acceptedEmails: "valid_and_catch_all", excludeEmailedWithin: "3_months" });
    expect(serveBody(src)).toEqual({ acceptedEmails: "valid_and_catch_all" });
    expect(statesFreshContacts(out)).toBe(true);
    expect(statesFreshContacts(src)).toBe(false);
    expect(out.nodes.filter((n) => n.id !== "fetch-lead")).toEqual(src.nodes.filter((n) => n.id !== "fetch-lead"));
  });

  it("a serve of people already contacted (a population) is a re-engagement play: never stated", () => {
    const contacted = applyDagPatch(buildSourcingDag(), CONTACTED_PROSPECTS_CHANGES as never);
    expect(freshContactsApplies(contacted)).toBe(false);
    expect(() => withFreshContacts(contacted)).toThrow(/not a cold serve/);
  });

  it("refuses a DAG without a serve, and a serve whose body comes from an input mapping", () => {
    const noServe: DAG = { nodes: [{ id: "a", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } }], edges: [] };
    expect(() => withFreshContacts(noServe)).toThrow(/not a cold serve/);
    const mapped = coldEmail();
    mapped.nodes[1].inputMapping = { body: "$ref:start-run.output" };
    expect(() => withFreshContacts(mapped)).toThrow(/refusing to override/);
  });

  it("the description says it once, in plain words", () => {
    const d = freshContactsDescription("Writes cold emails.");
    expect(d.startsWith("Writes cold emails. " + FRESH_CONTACTS_MARKER)).toBe(true);
    expect(d).toMatch(/emailed in the last 3 months/);
    expect(freshContactsDescription(d)).toBe(d);
  });
});

describe("the sourcing seed carries Fresh contacts only on cold channels and never flattens it", () => {
  it("a cold channel's generic DAG states it; CRM contacts does not", () => {
    expect(serveBody(buildSourcingDagFor("lead-sourcing"))).toEqual({ excludeEmailedWithin: "3_months" });
    expect(serveBody(buildSourcingDagFor("sourcing-apollo-cold-filters"))).toEqual({ excludeEmailedWithin: "3_months" });
    expect(serveBody(buildSourcingDagFor("sourcing-crm-contacts"))).toBeUndefined();
    expect(sourcingDescriptionOf("lead-sourcing")).toContain(FRESH_CONTACTS_MARKER);
    expect(sourcingDescriptionOf("sourcing-crm-contacts")).toBe(SOURCING_DESCRIPTION);
  });

  it("the stored generic row upgraded by the script is current for the seed (generic, nothing to redo)", () => {
    const current = buildSourcingDagFor("lead-sourcing");
    const stored = withFreshContacts(buildSourcingDag());
    expect(stored).toEqual(current);
    expect(sourcingTargetOf(stored, current)).toEqual({ dag: current, stated: false });
    expect(sourcingTargetOf(buildSourcingDag(), current)).toEqual({ dag: current, stated: false });
  });

  it("a catch-all copy on a cold channel keeps its body AND gains the window", () => {
    const current = buildSourcingDagFor("lead-sourcing");
    const stored = applyDagPatch(buildSourcingDag(), [{ op: "add", path: "/nodes/serve-lead/config/body", value: { acceptedEmails: "valid_and_catch_all" } }]);
    const r = sourcingTargetOf(stored, current);
    expect(r.stated).toBe(true);
    expect(serveBody(r.dag)).toEqual({ excludeEmailedWithin: "3_months", acceptedEmails: "valid_and_catch_all" });
  });

  it("the contacted pure prospects copy never gains it", () => {
    const current = buildSourcingDagFor("lead-sourcing");
    const forked = applyDagPatch(current, CONTACTED_PROSPECTS_CHANGES as never);
    expect(serveBody(forked)).toEqual({ population: "contacted_pure_prospects" });
    expect(serveBody(sourcingTargetOf(forked, current).dag)).toEqual({ population: "contacted_pure_prospects" });
  });

  it("a CRM copy stays exactly what it states", () => {
    const current = buildSourcingDagFor("sourcing-crm-contacts");
    const stored = applyDagPatch(buildSourcingDag(), [{ op: "add", path: "/nodes/serve-lead/config/body", value: { reachableBy: ["phone"] } }]);
    expect(serveBody(sourcingTargetOf(stored, current).dag)).toEqual({ reachableBy: ["phone"] });
  });
});
