import { describe, it, expect } from "vitest";
import { plainDescription, descriptionProblem, DESCRIPTION_RULES } from "../../src/lib/plain-description.js";
// @ts-expect-error: plain .mjs ops script
import { dagShape, groupKey } from "../../scripts/rewrite-descriptions-1022.mjs";
import { buildSystemPrompt } from "../../src/lib/prompt-templates.js";

describe("BEST-TPL-LLM-1022 plain descriptions", () => {
  it("rewrites em/en dashes: a hyphen between digits, a comma elsewhere", () => {
    expect(plainDescription("Cold email — three steps, days 3–7.")).toBe("Cold email, three steps, days 3-7.");
    expect(plainDescription("Sends one email—then waits.")).toBe("Sends one email, then waits.");
    expect(plainDescription(null)).toBeNull();
  });

  it("refuses a description naming a template, a model, a test or a date, a dash, or more than two sentences", () => {
    expect(descriptionProblem("Anthropic credits test (2026-10-10): template cold-email-v27 with model pro.")).not.toBeNull();
    expect(descriptionProblem("Cold email pipeline on GLM.")).toMatch(/glm/i);
    expect(descriptionProblem("Sends a cold email — then stops.")).toMatch(/dash/);
    expect(descriptionProblem("One. Two. Three.")).toMatch(/3 sentences/);
    expect(descriptionProblem("Sends one cold email to fresh contacts only, then two follow-ups three and seven days later.")).toBeNull();
  });

  it("the generator is told the same rules", () => {
    expect(DESCRIPTION_RULES).toMatch(/Never name a template, a model/);
    expect(buildSystemPrompt()).toContain(DESCRIPTION_RULES);
  });

  it("groups rows by old description and DAG shape, ignoring the writer's template and model", () => {
    const dag = (model: string) => ({ nodes: [{ id: "g", type: "http.call", config: { service: "content-generation", method: "POST", path: "/generate", body: { model, type: "x", variables: { a: 1 } } } }], edges: [] });
    expect(groupKey("d", dag("pro"))).toBe(groupKey("d", dag("opus")));
    expect(groupKey("d", dag("pro"))).not.toBe(groupKey("e", dag("pro")));
    expect(dagShape(dag("pro")).nodes[0]).toEqual({ id: "g", type: "http.call", call: "POST content-generation /generate", body: { variables: { a: 1 } } });
  });
});

describe("every description a seed or copy writes reads right", async () => {
  const follow = await import("../../src/lib/follow-up-dag.js");
  const form = await import("../../src/lib/form-meeting-booking-dag.js");
  const proposal = await import("../../src/lib/ai-lead-proposal-dag.js");
  const wa = await import("../../src/lib/cold-whatsapp-outreach-dag.js");
  const video = await import("../../src/lib/industry-update-video-dag.js");
  const call = await import("../../src/lib/ai-instant-call-dag.js");
  const push = await import("../../src/lib/email-sending-dag.js");
  const sourcing = await import("../../src/lib/sourcing-dag.js");
  const doc = await import("../../src/lib/offer-document-reply-dag.js");
  const { reachableByDescription } = await import("../../src/lib/reachable-by-copy.js");
  const { freshContactsDescription } = await import("../../src/lib/fresh-contacts.js");
  const texts: Record<string, string> = {
    proactiveFollowUp: follow.FOLLOW_UP_PROACTIVE_DESCRIPTION,
    reactiveFollowUp: follow.FOLLOW_UP_REACTIVE_DESCRIPTION,
    figuresFollowUp: follow.FOLLOW_UP_REACTIVE_FIGURES_DESCRIPTION,
    form: form.FORM_MEETING_BOOKING_DESCRIPTION,
    proposal: proposal.AI_LEAD_PROPOSAL_DESCRIPTION,
    whatsapp: wa.COLD_WHATSAPP_OUTREACH_DESCRIPTION,
    video: video.INDUSTRY_UPDATE_DESCRIPTION,
    call: call.AI_INSTANT_CALL_DESCRIPTION,
    callEmailOnly: call.EMAIL_REPLIES_ONLY_DESCRIPTION,
    push: push.EMAIL_SENDING_DESCRIPTION,
    sourcing: sourcing.SOURCING_DESCRIPTION,
    businessOnly: sourcing.BUSINESS_ONLY_SOURCING_DESCRIPTION,
    followUpDue: sourcing.LEAD_FOLLOW_UP_DUE_SOURCING_DESCRIPTION,
    offerDocument: doc.DESCRIPTION,
    phoneCopy: reachableByDescription(sourcing.SOURCING_DESCRIPTION, ["phone"]),
    freshSourcing: freshContactsDescription(sourcing.SOURCING_DESCRIPTION),
  };
  for (const [name, text] of Object.entries(texts)) {
    it(`${name}: plain, no template/model/test/date, no dash, two sentences at most`, () => {
      expect(descriptionProblem(text)).toBeNull();
    });
  }
});
