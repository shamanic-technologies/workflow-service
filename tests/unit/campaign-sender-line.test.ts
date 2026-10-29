import { describe, it, expect } from "vitest";
import { dagToOpenFlow, campaignSenderLineExpr, CAMPAIGN_SENDER_LINE_FIELD } from "../../src/lib/dag-to-openflow.js";
import { buildLeadFollowUpLeadsOnlyDag } from "../../src/lib/lead-follow-up-leads-dag.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";

/** CAMPAIGN-WA-LINE-1028: a campaign's stated WhatsApp line rides every crm WhatsApp reach/send body. */
type Mod = { id: string; value?: { type?: string; input_transforms?: Record<string, { type: string; expr?: string; value?: unknown }>; branches?: Array<{ modules: Mod[] }>; default?: Mod[] } };

function allModules(mods: Mod[]): Mod[] {
  return mods.flatMap((m) => [m, ...allModules(m.value?.default ?? []), ...(m.value?.branches ?? []).flatMap((b) => allModules(b.modules))]);
}

function bodyOf(flow: ReturnType<typeof dagToOpenFlow>, id: string) {
  const mod = allModules(flow.value.modules as unknown as Mod[]).find((m) => m.id === id);
  return mod?.value?.input_transforms?.body;
}

const run = (bodyExpr: string, line: unknown) =>
  new Function("results", `return ${campaignSenderLineExpr(bodyExpr, "results.start_run?." + CAMPAIGN_SENDER_LINE_FIELD)};`)({ start_run: { whatsappSenderPhone: line } });

describe("campaign WhatsApp line", () => {
  it("adds the stated line as fromAccount, and leaves the body byte-identical when none is stated", () => {
    expect(run(`({brandId: "b", phone: "+1"})`, "+77776879632")).toEqual({ brandId: "b", phone: "+1", fromAccount: "+77776879632" });
    expect(run(`({brandId: "b", fromAccount: "+33680478702"})`, null)).toEqual({ brandId: "b", fromAccount: "+33680478702" });
    expect(run(`({brandId: "b"})`, "")).toEqual({ brandId: "b" });
    expect(run(`null`, "+77776879632")).toBeNull();
  });

  it("never adds fromAccount beside a line role the body states (crm-service 400s them together)", () => {
    expect(run(`({brandId: "b", fromLine: "founder"})`, "+77776879632")).toEqual({ brandId: "b", fromLine: "founder" });
    expect(run(`({brandId: "b", fromAccountType: "pro_ai"})`, "+77776879632")).toEqual({ brandId: "b", fromAccountType: "pro_ai" });
  });

  for (const [name, dag, ids] of [
    ["the Lead event follow-up", buildLeadFollowUpLeadsOnlyDag({ readFigures: false }), ["reach_check", "send_whatsapp"]],
    ["cold WhatsApp", buildColdWhatsappOutreachDag(), ["reach_check"]],
  ] as const) {
    it(`wraps every WhatsApp reach and send of ${name}`, () => {
      const flow = dagToOpenFlow(dag, "x");
      for (const id of ids) {
        const body = bodyOf(flow, id);
        expect(body?.type, id).toBe("javascript");
        expect(body?.expr, id).toContain(`results.start_run?.${CAMPAIGN_SENDER_LINE_FIELD}`);
      }
    });
  }
});
