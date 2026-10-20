import { describe, it, expect } from "vitest";
import {
  CATCH_ALL_COPY_SENTENCE,
  NO_EMAIL_VERDICT_MARKER,
  NO_EMAIL_VERDICT_SENTENCE,
  noEmailVerdictDescription,
  statesEmailVerdict,
  withoutEmailVerdict,
} from "../../src/lib/email-verdict-preference.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";

const source = (): DAG => ({
  nodes: [
    { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
    { id: "fetch-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next", body: { excludeEmailedWithin: "3_months" } } },
    { id: "gen", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { type: "cold-email-v53", model: "fable" } } },
  ],
  edges: [{ from: "start-run", to: "fetch-lead" }, { from: "fetch-lead", to: "gen" }],
});
const copyOf = (dag: DAG): DAG => {
  const c = structuredClone(dag);
  (c.nodes[1].config as { body: Record<string, unknown> }).body.acceptedEmails = "valid_and_catch_all";
  return c;
};

describe("Cold Email workflows state no email verdict (DOTTEREL-EMAIL-FILTER-1020)", () => {
  it("detects a stated or mapped preference, not a serve without one", () => {
    expect(statesEmailVerdict(copyOf(source()))).toBe(true);
    expect(statesEmailVerdict(source())).toBe(false);
    const mapped = source();
    mapped.nodes[1].inputMapping = { "body.acceptedEmails": "$ref:flow_input.x" };
    expect(statesEmailVerdict(mapped)).toBe(true);
  });

  it("removes only the key: fresh-contacts window, template and model untouched, source not mutated", () => {
    const copy = copyOf(source());
    const out = withoutEmailVerdict(copy);
    expect(out).toEqual(source());
    expect(statesEmailVerdict(out)).toBe(false);
    expect((copy.nodes[1].config as { body: Record<string, unknown> }).body.acceptedEmails).toBe("valid_and_catch_all");
    expect(validateDAG(out).valid).toBe(true);
    // a copy minus its one change IS its source: same signature (the upgrade 409s on the active twin)
    expect(computeDAGSignature(out)).toBe(computeDAGSignature(source()));
  });

  it("refuses to guess a preference that arrives by input mapping", () => {
    const mapped = source();
    mapped.nodes[1].inputMapping = { body: "$ref:x.output" };
    expect(() => withoutEmailVerdict(mapped)).toThrow(/refusing to guess/);
  });

  it("drops the catch-all copy sentence and appends the plain one once", () => {
    const desc = `Writes a cold email. ${CATCH_ALL_COPY_SENTENCE} Fresh contacts only: skips 3 months.`;
    const out = noEmailVerdictDescription(desc);
    expect(out).toBe(`Writes a cold email. Fresh contacts only: skips 3 months. ${NO_EMAIL_VERDICT_SENTENCE}`);
    expect(out.toLowerCase()).not.toContain("catch-all");
    expect(noEmailVerdictDescription(out)).toBe(out);
    expect(noEmailVerdictDescription(null)).toBe(NO_EMAIL_VERDICT_SENTENCE);
    expect(out.split(NO_EMAIL_VERDICT_MARKER)).toHaveLength(2);
  });
});
