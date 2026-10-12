/**
 * The DAG of the `ai-follow-up-email` channel ("AI Follow-up Email", features-service): ONE warm email to ONE
 * known person, written from the campaign's free-text `instruction`, able to START a thread.
 *
 * Its pipe is `ai-follow-up-email|signup_to_paid_client`, REACTIVE on the `follow_up_due` trigger (kind
 * `reported`). Whoever wants the follow-up (first caller: the distribute.you Copilot, which estimated something and
 * promised the exact figure later) creates a funnel campaign that NAMES its people and carries an `instruction`;
 * when the trigger is reported, campaign-service makes each named person DUE on that campaign's own lead-service
 * follow-up queue and dispatches this workflow, like every campaign. Nothing here is Copilot-only: the instruction
 * rides `/start-run` for every funnel unit, so any channel's workflow can read it the same way.
 *
 * One run writes to EXACTLY ONE person:
 *
 *  - The instruction is read off `/start-run` at THIS run, never cached, so an edit is what the next run uses. A
 *    campaign with no instruction has nothing to say: the run names it and fails (`success: false`) before
 *    claiming anyone, rather than writing an email from nothing.
 *  - The person is claimed from THIS campaign's own queue (`claim-next`, atomic, at most one, exactly once). Unlike
 *    `ai-meeting-booking` there is no predecessor: this campaign names its person itself. Nobody due ends the run
 *    as idle (`noWorkAvailable`).
 *  - Before writing, the figures the instruction needs are READ (`read-figures`, this service's own
 *    `POST /orgs/figures/read`, a capability any workflow can call): public figures, and the figures of the
 *    organization(s) the PERSON belongs to, read as that person and never another customer's. So "give Marie her
 *    exact cost per booked meeting" needs no number in the instruction.
 *  - The email is written by the model through chat-service `/complete` (which owns the model, the key and the
 *    cost declaration), from the instruction, the figures read, and what the CLIENT told us (`GATHER_FACTS_CODE`,
 *    shared with `ai-meeting-booking`: offer answers and confirmed user-fields, never the website). It may refuse:
 *    `cannot_write` when the instruction asks for something none of those hold (a figure that could not be read,
 *    e.g. another organization's). Then nothing is sent, the person's claim is released as `stopped` (so an
 *    edited instruction plus a new report can try again), and the run fails, named in the log.
 *  - The email goes out as a NEW thread through email-gateway's broadcast send (Instantly, our sending infra), so
 *    it lands in the Unibox like any outreach and the reply is threaded there. The send carries an idempotency key
 *    on the person's queue row.
 *  - Strictly AFTER the send, the person's row is marked `handed` (reason `follow_up_sent`) on lead-service:
 *    permanent, so no automated responder ever claims them again on this campaign, and a second `follow_up_due`
 *    report schedules nothing (lead-service leaves the due date NULL on a handed row). That is what makes "the
 *    same debt is never answered twice" structural rather than a hope; their reply belongs to a person.
 *
 * No em dash or en dash ever reaches the person: the prompt bans them and `finalize-email` rewrites any that slip
 * through, before the send.
 */
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";

export const AI_FOLLOW_UP_EMAIL_FEATURE_SLUG = "ai-follow-up-email";

/** The leg the AI Follow-up Email pipe performs (Signup -> Paid client). */
export const AI_FOLLOW_UP_EMAIL_LEG_KEY = "signup_to_paid_client";

export const AI_FOLLOW_UP_EMAIL_PIPE_ID = `${AI_FOLLOW_UP_EMAIL_FEATURE_SLUG}|${AI_FOLLOW_UP_EMAIL_LEG_KEY}`;

export const AI_FOLLOW_UP_EMAIL_DESCRIPTION =
  "Writes ONE email to ONE named person when their follow-up is due: claims them from the campaign's own " +
  "follow-up queue, writes the email from the campaign's instruction and what the client told us, sends it as a " +
  "new thread from our sending infra so it lands in the Unibox, and then marks the person as handed so they are " +
  "never written to twice.";

/** The model the email is written with, through chat-service. Always-thinking: no temperature. */
export const AI_FOLLOW_UP_EMAIL_LLM = { provider: "anthropic", model: "opus" } as const;

/** Stored on the person's queue row once the email went out: handed, permanent. */
export const FOLLOW_UP_SENT_REASON = "follow_up_sent";

/** Stored when the model could not write what the instruction asks: stopped, so a later report can retry. */
export const INSTRUCTION_NOT_WRITABLE_REASON = "instruction_not_writable";

/** The condition the instruction is present under. Its exact negation is the other arm. */
export const HAS_INSTRUCTION =
  "typeof results['start-run']?.instruction == 'string' && results['start-run'].instruction.trim() != ''";

/** States, in the log, that this campaign carries no instruction; `/end-run` has no reason field. */
export const NAME_MISSING_INSTRUCTION_CODE = `
export async function main(campaignId) {
  console.error("[ai-follow-up-email] campaign " + String(campaignId) +
    " carries no instruction; there is nothing to write, nobody was claimed and nothing was sent");
  return { outcome: "no_instruction", campaignId: campaignId ?? null };
}
`.trim();

export const EMAIL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["write", "cannot_write"] },
    subject: { type: "string", description: "The subject line. Empty when decision is cannot_write." },
    bodyHtml: { type: "string", description: "The email body as simple HTML paragraphs. Empty when decision is cannot_write." },
    reason: { type: "string", description: "One sentence: what the email does, or what is missing to write it." },
  },
  required: ["decision", "subject", "bodyHtml", "reason"],
} as const;

/**
 * Builds the system prompt and the message. chat-service `/complete` takes one flat `message`, so the
 * interpolation happens in the flow; this is also what makes the prompt readable in the stored DAG.
 */
export const COMPOSE_EMAIL_PROMPT_CODE = `
export async function main(instruction, followup, leadDetail, offer, brand, facts, figures, currentDate) {
  const text = typeof instruction === "string" ? instruction.trim() : "";
  if (!text) throw new Error("compose-email: the campaign carries no instruction");
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose-email: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose-email: the brand read carries no name");

  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const person = leadDetail?.leadDetail?.lead ?? {};
  const org = person.organization ?? {};
  const personLines = [
    ["Email", followup?.followup?.email],
    ["Name", [person.firstName, person.lastName].filter(present).join(" ")],
    ["Title", person.currentTitle],
    ["Company", org.name],
  ].filter(([, v]) => present(v)).map(([k, v]) => k + ": " + String(v).trim());

  const exact = facts?.exact ?? [];
  const neverGive = facts?.neverGive ?? [];
  if (!figures || !Array.isArray(figures.figures)) throw new Error("compose-email: the figure read returned no figures list");
  const read = figures.figures;
  const notRead = typeof figures.missing === "string" && figures.missing.trim() ? figures.missing.trim() : null;

  const systemPrompt = [
    "You write ONE email from the team at " + brandName + " to one person who already knows us. It starts a new thread.",
    "You follow the INSTRUCTION below. It says why we write and what the email must say. Do what it asks, nothing more.",
    "You state only what the INSTRUCTION, the FIGURES or the FACTS say. Never invent a figure, a date, a price, a promise or a result. A number appears in the email only if it is written in the instruction, the figures or the facts, exactly as written there.",
    "The FIGURES were read for this email from this person's own account or from public data. Use them as given. You may say a figure in a plainer unit (731 cents is $7.31), never change its value.",
    "If the instruction asks you to tell them something none of those contain (for example a figure that could not be read), do not write around it: set decision to cannot_write, leave subject and bodyHtml empty, and say in reason exactly what is missing.",
    "Write like a person who knows them: short, plain, warm, one idea per sentence. Greet them by first name when you have it. No sales pitch, no filler, no \\"I hope this finds you well\\".",
    "Never use an em dash or an en dash. Use a comma or a period.",
    "Do not sign off with a name or a signature block: ours is added below your text. End with your last sentence.",
    "bodyHtml is simple HTML: <p> paragraphs only. The subject is short and plain.",
  ].join("\\n");

  const message = [
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "",
    "INSTRUCTION:",
    text,
    "",
    "WHO WE WRITE TO:",
    ...(personLines.length ? personLines : ["(nothing beyond their email)"]),
    "",
    "WHO WE ARE: " + brandName + ", offer \\"" + offerName + "\\".",
    "",
    "FIGURES read for this email (from their own account, or public):",
    ...(read.length ? read.map((f, i) => "F" + (i + 1) + ". " + f.label + ": " + f.value + " (source: " + f.source + ")") : ["(none)"]),
    ...(notRead ? ["NOT READABLE: " + notRead] : []),
    "",
    "FACTS our client told us:",
    ...(exact.length ? exact.map((f) => f.id + ". " + f.label + ": " + f.value) : ["(none)"]),
    ...(neverGive.length ? ["", "NEVER offer or promise any of these, whole or in part:", ...neverGive.map((x) => "- " + x)] : []),
  ].join("\\n");

  return { systemPrompt, message };
}
`.trim();

/**
 * Holds the model to its contract before anything is sent: a `write` with an empty subject or body is a broken
 * contract (throws), and any em/en dash is rewritten (between digits a hyphen, otherwise a comma). Builds the
 * one-step sequence and the send's idempotency key, which names the person's queue row.
 */
export const FINALIZE_EMAIL_CODE = `
export async function main(draft, followup) {
  const json = draft?.json ?? {};
  const rowId = followup?.followup?.id;
  if (!rowId) throw new Error("finalize-email: no claimed queue row");
  if (json.decision === "cannot_write") {
    console.error("[ai-follow-up-email] the instruction cannot be written from what we hold; nothing is sent. Missing: " +
      JSON.stringify(json.reason ?? null));
    return { decision: "cannot_write", reason: json.reason ?? null };
  }
  if (json.decision !== "write") throw new Error("finalize-email: unknown decision " + JSON.stringify(json.decision));
  const undash = (s) => String(s ?? "")
    .replace(/&(mdash|ndash);|&#(8212|8211|x2014|x2013);/gi, (m) => (/mdash|8212|2014/i.test(m) ? "\\u2014" : "\\u2013"))
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const subject = undash(json.subject);
  const bodyHtml = undash(json.bodyHtml);
  if (!subject || !bodyHtml) throw new Error("finalize-email: decision write with an empty subject or body");
  if (subject !== String(json.subject ?? "").trim() || bodyHtml !== String(json.bodyHtml ?? "").trim()) {
    console.error("[ai-follow-up-email] the draft used a dash the person must never read; rewritten before the send");
  }
  return {
    decision: "write",
    subject,
    sequence: [{ step: 1, bodyHtml, daysSinceLastStep: 0 }],
    idempotencyKey: "ai-follow-up-email:" + rowId,
  };
}
`.trim();

const GATHER_FACTS_SIGNATURE = "export async function main(plan, offerAnswers, offerFields, brandFields)";
if (!GATHER_FACTS_CODE.startsWith(GATHER_FACTS_SIGNATURE)) {
  throw new Error("ai-follow-up-email: GATHER_FACTS_CODE changed its signature; re-wrap it");
}

/**
 * `ai-meeting-booking`'s fact gathering, unchanged, with no question list: here the instruction is the ask.
 * Wrapped so every parameter of the script's `main` is one the DAG actually maps.
 */
export const GATHER_CLIENT_FACTS_CODE =
  GATHER_FACTS_CODE.replace(GATHER_FACTS_SIGNATURE, "async function gatherFacts(plan, offerAnswers, offerFields, brandFields)") +
  "\n\nexport async function main(offerAnswers, offerFields, brandFields) {\n" +
  "  return gatherFacts(null, offerAnswers, offerFields, brandFields);\n}";

const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
});

export function buildAiFollowUpEmailDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "check-instruction", type: "condition" },
      {
        id: "name-missing-instruction",
        type: "script",
        config: { code: NAME_MISSING_INSTRUCTION_CODE },
        retries: 0,
        inputMapping: { campaignId: "$ref:flow_input.campaignId" },
      },
      // THIS campaign's own queue: it names its person, there is no predecessor.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-claim", type: "condition" },
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
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.brandId" },
      },
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}" },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
        },
      },
      {
        id: "offer-answers",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
        inputMapping: {
          "params.brandId": "$ref:claim-followup.output.followup.brandId",
          "params.offerId": "$ref:start-run.output.offerId",
        },
      },
      {
        id: "offer-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
        inputMapping: {
          "params.brandId": "$ref:claim-followup.output.followup.brandId",
          "params.offerId": "$ref:start-run.output.offerId",
        },
      },
      {
        id: "brand-user-fields",
        type: "http.call",
        // Refused (409 SEVERAL_OFFERS) for a brand selling several offers: gather-facts reads that one
        // refusal as "no brand-level fields" and re-throws every other failure.
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
        inputMapping: { "params.brandId": "$ref:claim-followup.output.followup.brandId" },
      },
      // What the client told us. No question list here: the instruction is the ask.
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
      // The figures the instruction needs, read now: public ones and the PERSON's own account (never another
      // customer's). A figure that cannot be read comes back in `missing`, and the writer refuses.
      {
        id: "read-figures",
        type: "http.call",
        config: { service: "workflow", method: "POST", path: "/orgs/figures/read" },
        retries: 0,
        inputMapping: {
          "body.question": "$ref:start-run.output.instruction",
          "body.recipientEmail": "$ref:claim-followup.output.followup.email",
        },
      },
      {
        id: "compose-email",
        type: "script",
        config: { code: COMPOSE_EMAIL_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          instruction: "$ref:start-run.output.instruction",
          followup: "$ref:claim-followup.output",
          leadDetail: "$ref:lead-detail.output",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
          facts: "$ref:gather-facts.output",
          figures: "$ref:read-figures.output",
          currentDate: "$ref:flow_input.currentDate",
        },
      },
      {
        id: "draft-email",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: AI_FOLLOW_UP_EMAIL_LLM.provider,
            model: AI_FOLLOW_UP_EMAIL_LLM.model,
            responseFormat: "json",
            responseSchema: EMAIL_RESPONSE_SCHEMA,
            maxTokens: CHAT_STEP_MAX_TOKENS,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-email.output.message",
          "body.systemPrompt": "$ref:compose-email.output.systemPrompt",
        },
      },
      {
        id: "finalize-email",
        type: "script",
        config: { code: FINALIZE_EMAIL_CODE },
        retries: 0,
        inputMapping: { draft: "$ref:draft-email.output", followup: "$ref:claim-followup.output" },
      },
      // Converges (edge from claim-followup, outside check-claim's branch) so it is a top-level branchone.
      { id: "check-writable", type: "condition" },
      // A NEW thread from our sending infra: lands in the Unibox, the reply is threaded there.
      {
        id: "send-email",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/orgs/send",
          body: { type: "broadcast", tag: "ai-follow-up-email" },
          validateResponse: { field: "success", equals: true },
        },
        retries: 0,
        inputMapping: {
          "body.to": "$ref:claim-followup.output.followup.email",
          "body.subject": "$ref:finalize-email.output.subject",
          "body.sequence": "$ref:finalize-email.output.sequence",
          "body.idempotencyKey": "$ref:finalize-email.output.idempotencyKey",
          "body.leadId": "$ref:claim-followup.output.followup.leadId",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.workflowSlug": "$ref:start-run.output.workflowSlug",
          "body.timezone": "$ref:lead-detail.output.leadDetail.lead.timezone",
        },
      },
      // Strictly AFTER the send. Handed is permanent: never claimed again, a second report schedules nothing.
      {
        id: "record-sent",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "handed", reason: FOLLOW_UP_SENT_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.id" },
      },
      // Not writable: release the claim as stopped (not a tombstone), so an edited instruction can retry.
      {
        id: "release-unwritable",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: INSTRUCTION_NOT_WRITABLE_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:claim-followup.output.followup.id" },
      },
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-unwritable", { success: false, stopCampaign: false }),
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-no-instruction", { success: false, stopCampaign: false }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "check-instruction" },
      { from: "check-instruction", to: "claim-followup", condition: HAS_INSTRUCTION },
      { from: "check-instruction", to: "name-missing-instruction", condition: `!(${HAS_INSTRUCTION})` },
      { from: "name-missing-instruction", to: "end-run-no-instruction" },
      { from: "claim-followup", to: "check-claim" },
      // Converges rather than nesting inside check-instruction's branch; `?.` because on the
      // no-instruction path the claim never ran.
      { from: "start-run", to: "check-claim" },
      { from: "check-claim", to: "offer-economics", condition: "results['claim-followup']?.found == true" },
      { from: "check-claim", to: "end-run-nobody-due", condition: "results['claim-followup']?.found == false" },
      { from: "offer-economics", to: "brand-profile" },
      { from: "brand-profile", to: "lead-detail" },
      { from: "lead-detail", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "gather-facts" },
      { from: "gather-facts", to: "read-figures" },
      { from: "read-figures", to: "compose-email" },
      { from: "compose-email", to: "draft-email" },
      { from: "draft-email", to: "finalize-email" },
      { from: "finalize-email", to: "check-writable" },
      { from: "claim-followup", to: "check-writable" },
      { from: "check-writable", to: "send-email", condition: "results['finalize-email']?.decision == 'write'" },
      { from: "check-writable", to: "release-unwritable", condition: "results['finalize-email']?.decision == 'cannot_write'" },
      { from: "send-email", to: "record-sent" },
      { from: "record-sent", to: "end-run" },
      { from: "release-unwritable", to: "end-run-unwritable" },
    ],
    onError: "end-run-error",
  };
}
