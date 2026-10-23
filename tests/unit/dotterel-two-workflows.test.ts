import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DOTTEREL_ABSORBED,
  DOTTEREL_DESCRIPTIONS,
  DOTTEREL_KEPT,
  FULL_BRIEF_MAPPINGS,
  generateInputDiff,
  withFullWriterBrief,
} from "../../src/lib/dotterel-two-workflows.js";
import { computeDAGSignature } from "../../src/lib/dag-signature.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { descriptionProblem } from "../../src/lib/plain-description.js";

// Prod DAGs as stored on 2026-10-23 (Ballad v9, Keel v5, Cerulean v9).
const load = (f: string): DAG => JSON.parse(readFileSync(new URL(`../fixtures/${f}`, import.meta.url), "utf8"));
const ballad = load("dotterel-ballad-v9.dag.json");
const keel = load("dotterel-keel-v5.dag.json");
const cerulean = load("dotterel-cerulean-v9.dag.json");
const gen = (d: DAG) => d.nodes.find((n) => n.id === "email-generate")!.inputMapping!;
const send = (d: DAG) => d.nodes.find((n) => n.id === "email-send")!.inputMapping!;

describe("DOTTEREL-TWO-WORKFLOWS-1023", () => {
  it("gives Ballad and Keel today's date, the brand's fields (not the envelope), the real keywords and the send timezone", () => {
    for (const d of [ballad, keel]) {
      const up = withFullWriterBrief(d);
      for (const [k, v] of Object.entries(FULL_BRIEF_MAPPINGS)) expect(gen(up)[k]).toBe(v);
      expect(send(up)["body.timezone"]).toBe("$ref:fetch-lead.output.lead.data.timezone");
      expect(validateDAG(up).valid).toBe(true);
      expect(computeDAGSignature(up)).not.toBe(computeDAGSignature(d));
    }
  });

  it("matches the shape the healthy siblings already use for the brand fields and date", () => {
    expect(gen(withFullWriterBrief(ballad))["body.variables.brandExtractedFields"]).toBe(gen(cerulean)["body.variables.brandExtractedFields"]);
    expect(gen(withFullWriterBrief(ballad))["body.variables.currentDate"]).toBe(gen(cerulean)["body.variables.currentDate"]);
  });

  it("leaves Keel differing from Ballad ONLY by the brand's website link on the writer", () => {
    expect(generateInputDiff(withFullWriterBrief(ballad), withFullWriterBrief(keel))).toEqual([
      "body.variables.clientWebsite: (none) -> $ref:brand-profile.output.brand.clickDestinationUrl",
    ]);
  });

  it("keeps the writer free (template and LLM picked per run) and Keel's one-leg mark", () => {
    const up = withFullWriterBrief(keel);
    expect(gen(up)["body.type"]).toBe("$ref:template-head.output.template.type");
    expect(gen(up)["body.model"]).toBe("$ref:writer-plan.output.model");
    expect((up as DAG & { forkedForPipe?: string }).forkedForPipe).toBe("sales-cold-email-outreach|lead_found_to_conversation");
  });

  it("is idempotent and never mutates its input", () => {
    const before = JSON.stringify(ballad);
    const once = withFullWriterBrief(ballad);
    expect(JSON.stringify(ballad)).toBe(before);
    expect(computeDAGSignature(withFullWriterBrief(once))).toBe(computeDAGSignature(once));
  });

  it("refuses a DAG it would have to guess", () => {
    const noBrand = structuredClone(ballad);
    noBrand.nodes = noBrand.nodes.filter((n) => n.id !== "brand-extract-fields");
    expect(() => withFullWriterBrief(noBrand)).toThrow(/brand-extract-fields/);
    const wholeBody = structuredClone(ballad);
    wholeBody.nodes.find((n) => n.id === "email-generate")!.inputMapping = { body: "$ref:x.output" };
    expect(() => withFullWriterBrief(wholeBody)).toThrow(/whole body/);
  });

  it("states plain descriptions and merges exactly the six drifted copies into Ballad", () => {
    for (const s of DOTTEREL_KEPT) expect(descriptionProblem(DOTTEREL_DESCRIPTIONS[s])).toBeNull();
    expect(DOTTEREL_ABSORBED).toHaveLength(6);
    for (const s of DOTTEREL_KEPT) expect(DOTTEREL_ABSORBED).not.toContain(s);
  });
});
