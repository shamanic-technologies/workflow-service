import { describe, it, expect } from "vitest";
// @ts-expect-error plain ESM ops script, no types
import { restateCase, withSource } from "../../scripts/engine-ports/lead-found-source-store.mjs";

// SERVE-SOURCE-AS-DATA-1124: each Lead found script states where it finds people inside its own `serve` tactic.
describe("a Lead found script states its source", () => {
  it("reads the source off the channel the script states today, once", () => {
    expect(withSource({ serve: { excludeEmailedWithin: "3_months" }, channel: "sourcing-apollo-cold-filters", recorded_by: "lead" })).toEqual({
      serve: { excludeEmailedWithin: "3_months", findPeopleIn: "apollo_cold_filters" },
      channel: "sourcing-apollo-cold-filters",
      recorded_by: "lead",
    });
    expect(withSource({ serve: {}, channel: "sourcing-crm-contacts" })!.serve).toEqual({ findPeopleIn: "client_crm_contacts" });
  });

  it("leaves a population serve, a script with no channel, and one already stating it", () => {
    expect(withSource({ serve: { population: "lead_followup_due" }, channel: "lead-sourcing" })).toBeNull();
    expect(withSource({ serve: { population: "investors" } })).toBeNull();
    expect(withSource({ serve: { findPeopleIn: "sources_picked_for_the_brand" }, channel: "lead-sourcing" })).toBeNull();
  });

  it("restates only the lead.serve request of a recorded case", () => {
    const c = { id: "c1", calls: [{ name: "lead.serve", args: { excludeEmailedWithin: "3_months" }, answer: { ok: true } }, { name: "other", args: { a: 1 } }] };
    expect(restateCase(c, "apollo_cold_filters").calls).toEqual([
      { name: "lead.serve", args: { excludeEmailedWithin: "3_months", findPeopleIn: "apollo_cold_filters" }, answer: { ok: true } },
      { name: "other", args: { a: 1 } },
    ]);
  });
});
