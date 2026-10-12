/**
 * THE WORKFLOW OF THE COLD WHATSAPP OUTREACH PIPES (owner 2026-10-12: "every pipe in prod HAS a workflow").
 *
 * The channel `cold-whatsapp-outreach` has two proactive pipes (Lead found -> Positive reply, Lead found -> Website
 * visit). Both run THIS DAG: what differs between them is what features-service measures, never the step. One run
 * writes to AT MOST ONE person, on WhatsApp, from the brand's own linked WhatsApp account (crm-service owns the
 * account, the send, and the thread the message lands in, so the brand's team sees it in the Unibox and on their
 * phone, and takes over the moment the person answers).
 *
 * Each run, in order:
 *
 *  - The FOLLOW-UP comes first. This campaign's own lead-service queue (`claim-next`, atomic, at most one, exactly
 *    once) hands back a person whose follow-up is due: we wrote to them once, three days ago, and nobody since
 *    stopped the schedule. They get ONE follow-up, never a second: the row is then marked `handed` (permanent, no
 *    automated writer claims them again), so "at most one follow-up" is structural rather than a count we hope to
 *    respect.
 *  - Nobody due: the NEXT person is served by lead-service (`POST /orgs/buffer/next`, the same serve every
 *    outreach workflow calls; for the CRM pipe it hands out the brand's own people). Nobody left ends the run on
 *    the no-lead end-run, which the converter turns into "exhausted" only on lead-service's `audience_exhausted`.
 *  - The message is written by the model through chat-service `/complete` (which owns the model, the key and the
 *    cost declaration), from the campaign's own `instruction` (read off `/start-run` at THIS run, so an edit is
 *    what the next run writes from), what the CLIENT told us about the offer (`GATHER_FACTS_CODE`, never the
 *    website), the person as we know them, and a STRATEGY: start a real conversation, get to know them. Never a
 *    canned reply.
 *  - It is sent by crm-service on WhatsApp. A person we cannot reach there (no phone known, number not on
 *    WhatsApp, the brand's WhatsApp not linked or not connected, or, on the follow-up, they wrote to us since) is a named REFUSAL, not an error: the
 *    run names it in the log and ends as a normal run, and it is the email path's job to reach them. Any other
 *    failure fails the run loud.
 *  - Strictly AFTER the send, lead-service records what we owe them: a first message schedules the one follow-up
 *    (`schedule-by-email`, due in three days); a follow-up hands the row over for good. A refusal on a follow-up
 *    hands it over too (they answered: their thread is a person's now) or stops it (unreachable).
 *
 * Shape: three decisions (`check-due`, `check-person`, `check-record`) are SIBLING top-level branchones, each
 * pinned by a convergence edge from a node outside the previous decision's branch (`nodeToModule` builds a
 * condition nested in a branch as an ordinary module, which silently does nothing); every arm reads its evidence
 * with `?.`, because on another path the node it reads never ran.
 */
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";

export const COLD_WHATSAPP_OUTREACH_FEATURE_SLUG = "cold-whatsapp-outreach";

/** The legs the channel's pipes perform (features-service catalogue, 2026-10-12). */
export const COLD_WHATSAPP_OUTREACH_LEG_KEYS = ["lead_found_to_conversation", "lead_found_to_website_visit"] as const;

export const coldWhatsappPipeIdOf = (legKey: string): string => `${COLD_WHATSAPP_OUTREACH_FEATURE_SLUG}|${legKey}`;

export const COLD_WHATSAPP_OUTREACH_DESCRIPTION =
  "Writes to one person per run on WhatsApp, from the brand's own linked WhatsApp number, to start a real " +
  "conversation: a short first message written from the campaign's instruction, and at most one follow-up three " +
  "days later if they have not answered. The brand's team takes over as soon as they answer. A person we cannot " +
  "reach on WhatsApp is named and left to the email path.";

/** The model the message is written with, through chat-service. Always-thinking: no temperature. */
export const COLD_WHATSAPP_LLM = { provider: "anthropic", model: "opus" } as const;

/** Days between the first message and the one follow-up. */
export const FOLLOW_UP_AFTER_DAYS = 3;

/** Stored on the queue row once the follow-up went out: handed, permanent, so there is never a second one. */
export const WHATSAPP_FOLLOW_UP_SENT_REASON = "whatsapp_follow_up_sent";

/** The model's answer: the message, and one sentence on what it is for. */
export const MESSAGE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    message: { type: "string", description: "The WhatsApp message, plain text, exactly as the person will read it." },
    reason: { type: "string", description: "One sentence: what this message is trying to learn or start." },
  },
  required: ["message", "reason"],
} as const;

/**
 * Who this run writes to, from whichever path ran: the claimed follow-up (lead-detail read) or the newly served
 * lead. `kind` is `followup`, `first`, or `nobody` (nothing due and nobody served). Reads both with `?.`: exactly
 * one of them ran.
 */
export const PICK_PERSON_CODE = `
export async function main(claim, detail, served) {
  if (claim?.found === true) {
    const f = claim.followup ?? {};
    const lead = detail?.leadDetail?.lead ?? null;
    if (!f.id || !f.email) throw new Error("pick-person: a claimed follow-up carries no row id or email");
    if (!lead) throw new Error("pick-person: the claimed person's lead read returned no lead");
    return { kind: "followup", step: 2, rowId: f.id, leadId: f.leadId ?? null, email: f.email, brandId: f.brandId ?? null, lead };
  }
  if (served?.found === true) {
    const s = served.lead ?? {};
    if (!s.email) throw new Error("pick-person: a served lead carries no email");
    return { kind: "first", step: 1, rowId: null, leadId: s.leadId ?? null, email: s.email, brandId: (s.brandIds ?? [])[0] ?? null, lead: s.data ?? {} };
  }
  return { kind: "nobody", reason: served?.reason ?? claim?.reason ?? null };
}
`.trim();

/**
 * Builds the system prompt and the message. chat-service `/complete` takes one flat `message`, so the
 * interpolation happens in the flow; this is also what makes the prompt readable in the stored DAG.
 * The strategy is explained to the model, never a script per case (owner rule).
 */
export const COMPOSE_MESSAGE_PROMPT_CODE = `
export async function main(person, instruction, offer, brand, rep, facts, currentDate) {
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose-message: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose-message: the brand read carries no name");
  if (person?.kind !== "first" && person?.kind !== "followup") throw new Error("compose-message: no person to write to");

  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const lead = person.lead ?? {};
  const org = lead.organization ?? {};
  const personLines = [
    ["Name", [lead.firstName, lead.lastName].filter(present).join(" ")],
    ["Title", lead.currentTitle],
    ["Company", org.name],
    ["Company website", org.websiteUrl ?? org.primaryDomain],
    ["Industry", org.industry],
    ["City", [lead.city, lead.country].filter(present).join(", ")],
  ].filter(([, v]) => present(v)).map(([k, v]) => k + ": " + String(v).trim());

  const senderName = present(rep?.salesRepFirstName) ? rep.salesRepFirstName.trim() : null;
  const senderRole = present(rep?.salesRepRole) ? rep.salesRepRole.trim() : (senderName ? "founder" : null);
  const exact = facts?.exact ?? [];
  const neverGive = facts?.neverGive ?? [];
  const text = typeof instruction === "string" ? instruction.trim() : "";
  const followup = person.kind === "followup";

  const systemPrompt = [
    "You write ONE WhatsApp message from " + (senderName ? senderName + ", " + senderRole + " of " + brandName : "the founder of " + brandName) + ", to one person, from the brand's own WhatsApp number.",
    "THE GAME: we want a real conversation with this person, not a sale. We want to get to know them: what they want to grow, what they already tried to get there, whether they know what a new customer costs them (so we can compare with what we see elsewhere), what they think of us, what questions they have. A call is welcome if they want one. A useful tip that could make them more revenue is the best gift you can give. Pick ONE of these angles that fits what you know about them, and ask ONE easy question they can answer in a line. Never several questions.",
    followup
      ? "This is our ONE follow-up: we wrote to them " + "${FOLLOW_UP_AFTER_DAYS}" + " days ago and they did not answer. Do not repeat the first message and do not guilt them. Give them a different, lighter reason to answer, or a short tip, and make it easy to say no. There will be no other message after this one."
      : "This is our FIRST message to them on WhatsApp. Say who you are in a few words and why you are writing to them, personally.",
    "If an INSTRUCTION is given below, it is the campaign's own brief: follow it. It wins over the angle you would have picked.",
    "Write like a person texting someone they respect: short (2 to 4 short sentences, under 60 words), plain, warm, one idea per sentence. Greet them by first name when you have it. No sales pitch, no links unless the instruction gives one, no emoji unless natural, no filler, no \\"I hope this finds you well\\".",
    "State only what the INSTRUCTION or the FACTS say about us. Never invent a figure, a price, a promise, a result or a customer.",
    "English only. Never use an em dash or an en dash. Use a comma or a period.",
    senderName ? "End with your first name, " + senderName + ", on its own." : "Do not sign with a made-up name.",
  ].join("\\n");

  const message = [
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "",
    "INSTRUCTION:",
    text || "(none: follow THE GAME)",
    "",
    "WHO WE WRITE TO:",
    ...(personLines.length ? personLines : ["(nothing beyond their contact)"]),
    "",
    "WHO WE ARE: " + brandName + ", offer \\"" + offerName + "\\".",
    "",
    "FACTS our client told us:",
    ...(exact.length ? exact.map((f) => f.id + ". " + f.label + ": " + f.value) : ["(none)"]),
    ...(neverGive.length ? ["", "NEVER offer or promise any of these, whole or in part:", ...neverGive.map((x) => "- " + x)] : []),
  ].join("\\n");

  return { systemPrompt, message };
}
`.trim();

/**
 * Holds the model to its contract before anything is sent: an empty message throws, any em/en dash is rewritten
 * (between digits a hyphen, otherwise a comma). Builds the send's idempotency key: one per person per step.
 */
export const FINALIZE_MESSAGE_CODE = `
export async function main(draft, person, campaignId) {
  const json = draft?.json ?? {};
  const undash = (s) => String(s ?? "")
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const text = undash(json.message);
  if (!text) throw new Error("finalize-message: the model returned an empty message");
  if (text !== String(json.message ?? "").trim()) {
    console.error("[cold-whatsapp-outreach] the draft used a dash the person must never read; rewritten before the send");
  }
  const who = person?.leadId ?? person?.email;
  if (!who) throw new Error("finalize-message: no person to key the send on");
  return {
    text,
    idempotencyKey: "cold-whatsapp-outreach:" + String(campaignId) + ":" + String(who) + ":" + String(person.step),
    // The follow-up is never sent to someone who wrote to us since, on any channel.
    skipIfReplied: person.kind === "followup",
  };
}
`.trim();

/**
 * What lead-service must record, read off the send. A refusal is legible here and in the log; anything else threw
 * before this node.
 */
export const RECORD_PLAN_CODE = `
export async function main(person, send, currentDate) {
  const refused = send?.skipped === true;
  const code = refused ? String(send.code ?? "refused") : null;
  if (refused) {
    console.error("[cold-whatsapp-outreach] " + String(person?.email) + " not written on WhatsApp: " + code +
      " (" + String(send.refusal ?? send.error ?? "") + "). Left to the email path.");
  }
  if (person?.kind === "first") {
    if (refused) return { action: "none", outcome: "unreachable", code };
    const due = new Date(Date.now() + ${FOLLOW_UP_AFTER_DAYS} * 24 * 3600 * 1000).toISOString();
    return { action: "schedule", outcome: "sent", dueAt: due, email: person.email };
  }
  if (person?.kind === "followup") {
    if (!refused) return { action: "record", outcome: "sent", body: { kind: "handed", reason: "${WHATSAPP_FOLLOW_UP_SENT_REASON}" } };
    return { action: "record", outcome: "unreachable", code, body: { kind: "handed", reason: "whatsapp_" + code } };
  }
  throw new Error("record-plan: no person was written to");
}
`.trim();

const GATHER_FACTS_SIGNATURE = "export async function main(plan, offerAnswers, offerFields, brandFields)";
if (!GATHER_FACTS_CODE.startsWith(GATHER_FACTS_SIGNATURE)) {
  throw new Error("cold-whatsapp-outreach: GATHER_FACTS_CODE changed its signature; re-wrap it");
}

/** `ai-meeting-booking`'s fact gathering, unchanged, with no question list. */
export const GATHER_CLIENT_FACTS_CODE =
  GATHER_FACTS_CODE.replace(GATHER_FACTS_SIGNATURE, "async function gatherFacts(plan, offerAnswers, offerFields, brandFields)") +
  "\n\nexport async function main(offerAnswers, offerFields, brandFields) {\n" +
  "  return gatherFacts(null, offerAnswers, offerFields, brandFields);\n}";

/** crm-service's WhatsApp send (the brand's linked account). Wired against its served contract. */
export const CRM_WHATSAPP_SEND = { service: "crm", method: "POST", path: "/orgs/whatsapp/messages" } as const;

/**
 * crm-service refusals (422 `type: "refused"`) that mean "this person cannot be written to on WhatsApp now": they
 * end the person, not the run. `person_replied` only comes back on the follow-up (`skipIfReplied`): they wrote on
 * any channel, so their thread is a person's. `send_in_progress` (409), `invalid_request` and `bridge_error` are
 * NOT here: they fail the run loud.
 */
export const WHATSAPP_REFUSAL_CODES = [
  "whatsapp_not_linked",
  "whatsapp_not_connected",
  "no_phone_known",
  "not_on_whatsapp",
  "person_replied",
] as const;

const PERSON = "results['pick-person']";
const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
});

export function buildColdWhatsappOutreachDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      // The one follow-up first: this campaign's own queue.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-due", type: "condition" },
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
        },
      },
      // Nobody due: the next person.
      { id: "serve-lead", type: "http.call", config: { service: "lead", method: "POST", path: "/orgs/buffer/next" }, retries: 0 },
      // Converges (edge from claim-followup, outside check-due's branches) so it is top level.
      {
        id: "pick-person",
        type: "script",
        config: { code: PICK_PERSON_CODE },
        retries: 0,
        inputMapping: {
          claim: "$ref:claim-followup.output",
          detail: "$ref:lead-detail.output",
          served: "$ref:serve-lead.output",
        },
      },
      { id: "check-person", type: "condition" },
      {
        id: "offer-economics",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/offers/{offerId}/economics" },
        inputMapping: { "params.offerId": "$ref:start-run.output.offerId" },
      },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": "$ref:pick-person.output.brandId" },
      },
      // Who signs: the brand's stated rep, who answers on that WhatsApp number.
      {
        id: "sales-rep",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/sales-rep" },
        inputMapping: { "params.brandId": "$ref:pick-person.output.brandId" },
      },
      {
        id: "offer-answers",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
        inputMapping: {
          "params.brandId": "$ref:pick-person.output.brandId",
          "params.offerId": "$ref:start-run.output.offerId",
        },
      },
      {
        id: "offer-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
        inputMapping: {
          "params.brandId": "$ref:pick-person.output.brandId",
          "params.offerId": "$ref:start-run.output.offerId",
        },
      },
      {
        id: "brand-user-fields",
        type: "http.call",
        // Refused (409 SEVERAL_OFFERS) for a brand selling several offers: gather-facts reads that one
        // refusal as "no brand-level fields" and re-throws every other failure.
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
        inputMapping: { "params.brandId": "$ref:pick-person.output.brandId" },
      },
      {
        id: "gather-facts",
        type: "script",
        config: { code: GATHER_CLIENT_FACTS_CODE },
        retries: 0,
        inputMapping: {
          offerAnswers: "$ref:offer-answers.output",
          offerFields: "$ref:offer-user-fields.output",
          brandFields: "$ref:brand-user-fields.output",
        },
      },
      {
        id: "compose-message",
        type: "script",
        config: { code: COMPOSE_MESSAGE_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          instruction: "$ref:start-run.output.instruction",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
          rep: "$ref:sales-rep.output",
          facts: "$ref:gather-facts.output",
          currentDate: "$ref:flow_input.currentDate",
        },
      },
      {
        id: "draft-message",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: COLD_WHATSAPP_LLM.provider,
            model: COLD_WHATSAPP_LLM.model,
            responseFormat: "json",
            responseSchema: MESSAGE_RESPONSE_SCHEMA,
            maxTokens: CHAT_STEP_MAX_TOKENS,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-message.output.message",
          "body.systemPrompt": "$ref:compose-message.output.systemPrompt",
        },
      },
      {
        id: "finalize-message",
        type: "script",
        config: { code: FINALIZE_MESSAGE_CODE },
        retries: 0,
        inputMapping: {
          draft: "$ref:draft-message.output",
          person: "$ref:pick-person.output",
          campaignId: "$ref:flow_input.campaignId",
        },
      },
      {
        id: "send-whatsapp",
        type: "http.call",
        config: { ...CRM_WHATSAPP_SEND, skipOnRefusalCodes: [...WHATSAPP_REFUSAL_CODES] },
        retries: 0,
        inputMapping: {
          "body.email": "$ref:pick-person.output.email",
          "body.brandId": "$ref:pick-person.output.brandId",
          "body.text": "$ref:finalize-message.output.text",
          "body.idempotencyKey": "$ref:finalize-message.output.idempotencyKey",
          "body.skipIfReplied": "$ref:finalize-message.output.skipIfReplied",
        },
      },
      {
        id: "record-plan",
        type: "script",
        config: { code: RECORD_PLAN_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          send: "$ref:send-whatsapp.output",
          currentDate: "$ref:flow_input.currentDate",
        },
      },
      // Converges (edge from pick-person, outside check-person's branch) so it is top level.
      { id: "check-record", type: "condition" },
      // A first message went out: the one follow-up is owed in FOLLOW_UP_AFTER_DAYS.
      {
        id: "schedule-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/schedule-by-email" },
        retries: 0,
        inputMapping: {
          "params.campaignId": "$ref:flow_input.campaignId",
          "body.email": "$ref:record-plan.output.email",
          "body.dueAt": "$ref:record-plan.output.dueAt",
        },
      },
      // A follow-up (sent or refused): handed for good, never a second one.
      {
        id: "record-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups" },
        retries: 0,
        inputMapping: {
          "params.id": "$ref:pick-person.output.rowId",
          body: "$ref:record-plan.output.body",
        },
      },
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-followup", { success: true, stopCampaign: false }),
      endRun("end-run-unreachable", { success: true, stopCampaign: false }),
      endRun("end-run-no-lead", { success: true, stopCampaign: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "claim-followup" },
      { from: "claim-followup", to: "check-due" },
      { from: "check-due", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      { from: "check-due", to: "serve-lead", condition: "results['claim-followup']?.found != true" },
      { from: "lead-detail", to: "pick-person" },
      { from: "serve-lead", to: "pick-person" },
      { from: "claim-followup", to: "pick-person" },
      { from: "pick-person", to: "check-person" },
      { from: "check-person", to: "end-run-no-lead", condition: `${PERSON}?.kind == 'nobody'` },
      { from: "check-person", to: "offer-economics", condition: `${PERSON}?.kind == 'first' || ${PERSON}?.kind == 'followup'` },
      { from: "offer-economics", to: "brand-profile" },
      { from: "brand-profile", to: "sales-rep" },
      { from: "sales-rep", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "gather-facts" },
      { from: "gather-facts", to: "compose-message" },
      { from: "compose-message", to: "draft-message" },
      { from: "draft-message", to: "finalize-message" },
      { from: "finalize-message", to: "send-whatsapp" },
      { from: "send-whatsapp", to: "record-plan" },
      { from: "record-plan", to: "check-record" },
      { from: "pick-person", to: "check-record" },
      { from: "check-record", to: "schedule-followup", condition: "results['record-plan']?.action == 'schedule'" },
      { from: "check-record", to: "record-followup", condition: "results['record-plan']?.action == 'record'" },
      { from: "check-record", to: "end-run-unreachable", condition: "results['record-plan']?.action == 'none'" },
      { from: "schedule-followup", to: "end-run" },
      { from: "record-followup", to: "end-run-followup" },
    ],
    onError: "end-run-error",
  };
}
