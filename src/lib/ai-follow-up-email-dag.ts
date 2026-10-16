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
 *  - The instruction is read off `/start-run` at THIS run, never cached, so an edit is what the next run uses. It is
 *    OPTIONAL when the run answers a trigger OCCURRENCE (FACT-NOT-FOLLOWED-1014: "signed up, still not paid 30
 *    minutes later"): the fact itself is why we write. The trigger TYPE is read from features-service
 *    (`occurrence-fact.ts`) and put in front of the model as WHY WE WRITE NOW, with the person's state (their
 *    thread and recent events). A run with neither still asks the queue: a person due there is due because of the
 *    follow-up date WE set at our last look (below); nobody due ends IDLE (`noWorkAvailable`, never a failure,
 *    which would back the unit off and skip its next real occurrence).
 *  - The person is claimed from THIS campaign's own queue (`claim-next`, atomic, at most one, exactly once). Unlike
 *    `ai-meeting-booking` there is no predecessor: this campaign names its person itself. Nobody due ends the run
 *    as idle (`noWorkAvailable`).
 *  - Before writing, the figures the instruction needs are READ (not called when there is no instruction) (`read-figures`, this service's own
 *    `POST /orgs/figures/read`, a capability any workflow can call): public figures, and the figures of the
 *    organization(s) the PERSON belongs to, read as that person and never another customer's. So "give Marie her
 *    exact cost per booked meeting" needs no number in the instruction.
 *  - The email is written by the model through chat-service `/complete` (which owns the model, the key and the
 *    cost declaration), from the instruction, the figures read, and what the CLIENT told us (`GATHER_FACTS_CODE`,
 *    shared with `ai-meeting-booking`: offer answers and confirmed user-fields, never the website). It may refuse:
 *    `cannot_write` when the instruction asks for something none of those hold (a figure that could not be read,
 *    e.g. another organization's). Then nothing is sent, the person's claim is released as `stopped` (so an
 *    edited instruction plus a new report can try again), and the run fails, named in the log.
 *  - THE RIGHT MOMENT OR LATER (`right-moment.ts`, RIGHT-MOMENT-OR-LATER-1014, owner 2026-10-14 after a client was
 *    emailed a second time about something he had already answered by hand in the Unibox): the model first decides,
 *    from the whole thread and the events, whether NOW is the right moment. `later` sends nothing and makes the row
 *    due again at the model's date (`scheduled`); `stop` only on the person's own words (`stopped`); "already
 *    answered" never closes them.
 *  - `write`: the email goes out through email-gateway's broadcast send with `followUp: true`, so the sender
 *    replies in the brand's thread with them (same mailbox, `Re:` its subject; a new thread only when we never
 *    emailed them) and it lands in the Unibox. The idempotency key names the occurrence when the run's trigger names
 *    this person (a redelivery re-dues the same row, same event: `OCCURRENCE_SEND_KEY_FN`), else the row and its due
 *    date, so each follow-up of the same person is its own send. Strictly AFTER the send the row is `acted` with
 *    the model's next date: the queue row is the date's ONLY store, so the person is never without a next look. A
 *    passing refusal (a step of their sequence still queued, a live thread) sends nothing and keeps the date; an
 *    opt-out / not-a-prospect refusal stops the row.
 *
 * No em dash or en dash ever reaches the person: the prompt bans them and `finalize-email` rewrites any that slip
 * through, before the send.
 */
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";
import { personThreadNodes, relationshipReadNode, whoTheyAreNode } from "./person-relationship.js";
import { WHY_NOW_FN, WHY_NOW_STRATEGY, occurrencePlanNode, triggerTypeNode } from "./occurrence-fact.js";
import { OCCURRENCE_SEND_KEY_FN } from "./occurrence-send-key.js";
import { DELIVERED, refusedDelivery } from "./occurrence-delivery.js";
import {
  FOLLOW_UP_SEND_REFUSAL_CODES,
  NEXT_DATE_FN,
  NEXT_DATE_SCHEMA_PROPERTIES,
  NEXT_DATE_STRATEGY,
  RIGHT_MOMENT_STRATEGY,
  passingRefusal,
} from "./right-moment.js";

export const AI_FOLLOW_UP_EMAIL_FEATURE_SLUG = "ai-follow-up-email";

/** The leg the AI Follow-up Email pipe performs (Signup -> Paid client). */
export const AI_FOLLOW_UP_EMAIL_LEG_KEY = "signup_to_paid_client";

export const AI_FOLLOW_UP_EMAIL_PIPE_ID = `${AI_FOLLOW_UP_EMAIL_FEATURE_SLUG}|${AI_FOLLOW_UP_EMAIL_LEG_KEY}`;

export const AI_FOLLOW_UP_EMAIL_DESCRIPTION =
  "Follows up ONE named person when their follow-up is due: claims them from the campaign's own follow-up queue, " +
  "reads the whole thread and what they did, and first decides whether now is the right moment to write. If we " +
  "already answered them or the point was already made, it sends nothing and sets a later follow-up date. " +
  "Otherwise it writes from the campaign's instruction or the fact that made it due (signed up, still not paid) and " +
  "what the client told us, replies in the thread they wrote in last, and sets the next follow-up date. Only their " +
  "own words asking to stop or showing they are not a fit end the follow-ups.";

/** The model the email is written with, through chat-service. Always-thinking: no temperature. */
export const AI_FOLLOW_UP_EMAIL_LLM = { provider: "anthropic", model: "opus" } as const;

/** Stored on the person's queue row when the send was refused for good (opted out, not a prospect): stopped. */
export const FOLLOW_UP_REFUSED_REASON = "follow_up_refused";

/** Stored when the person's own words end the follow-ups (they asked us to stop, they are not a fit): stopped. */
export const FOLLOW_UP_STOPPED_REASON = "follow_up_stopped";

/** Stored when the model could not write what the instruction asks: stopped, so a later report can retry. */
export const INSTRUCTION_NOT_WRITABLE_REASON = "instruction_not_writable";

/**
 * Stored when the claimed person has no email address (a person known only by phone): stopped BEFORE any read or
 * model call, so an unreachable person costs nothing (LLM-SPEND-NO-SEND-1016).
 */
export const NO_EMAIL_KNOWN_REASON = "no_email_known";

/** The claimed person can be emailed at all: positive evidence, an address on the claimed row. */
export const HAS_EMAIL =
  "typeof results['claim-followup']?.followup?.email == 'string' && results['claim-followup']?.followup?.email.trim() != ''";

/**
 * The occurrence's truth when nothing can be sent to the person, stated FINAL so campaign-service never redelivers
 * the occurrence: a redelivery re-files the same person, who is drafted again by the model and refused again (four
 * Opus drafts for one person on a not-writable instruction, 2026-10-14).
 */
export const NO_EMAIL_DELIVERY = {
  state: "refused",
  code: NO_EMAIL_KNOWN_REASON,
  reason: "The person has no email address on record, so no email can be sent to them.",
} as const;

export const EMAIL_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["write", "later", "stop", "cannot_write"] },
    subject: { type: "string", description: "The subject line. Empty unless decision is write." },
    bodyHtml: { type: "string", description: "The email body as simple HTML paragraphs. Empty unless decision is write." },
    ...NEXT_DATE_SCHEMA_PROPERTIES,
    reason: {
      type: "string",
      description: "One sentence: what the email does, why now is not the moment, (stop) the person's own words that end the follow-ups, or what is missing to write it.",
    },
  },
  required: ["decision", "subject", "bodyHtml", "nextFollowUpAt", "nextFollowUpWhy", "reason"],
} as const;

/**
 * Builds the system prompt and the message. chat-service `/complete` takes one flat `message`, so the
 * interpolation happens in the flow; this is also what makes the prompt readable in the stored DAG.
 */
export const COMPOSE_EMAIL_PROMPT_CODE = `
export async function main(instruction, followup, leadDetail, offer, brand, facts, figures, currentDate, occurrence, triggerType, who) {
  if (!who || !Array.isArray(who.lines) || !Array.isArray(who.threadLines) || typeof who.strategy !== "string") {
    throw new Error("compose-email: who this person is to the brand was not read; nothing is written blind");
  }
  const text = typeof instruction === "string" ? instruction.trim() : "";
  const factLines = whyNowLines(occurrence, triggerType, followup?.followup?.email, new Date().toISOString());
  // Neither an instruction nor an occurrence: the person is due because of the follow-up date WE set at our last look.
  const whyNow = factLines.length || text ? factLines : [
    "The follow-up date we set at our last look at this person is reached. THE THREAD and the events say what we told them and what they did since.",
  ];
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
  // Not called (no instruction to read figures for): no figures, nothing missing.
  const skipped = figures?.notCalled === true;
  if (!skipped && (!figures || !Array.isArray(figures.figures))) throw new Error("compose-email: the figure read returned no figures list");
  const read = skipped ? [] : figures.figures;
  const notRead = !skipped && typeof figures.missing === "string" && figures.missing.trim() ? figures.missing.trim() : null;

  const systemPrompt = [
    "You follow up ONE person who already knows us, for the team at " + brandName + ": you decide whether to write now, and if so you write ONE email, a reply in the thread they wrote in last (a new thread only when we never exchanged an email).",
    text
      ? "You follow the INSTRUCTION below. It says why we write and what the email must say. Do what it asks, nothing more."
      : "There is no INSTRUCTION: why we write is WHY WE WRITE NOW below, and what the email says comes from where this person stands.",
    ...(factLines.length ? [${JSON.stringify(WHY_NOW_STRATEGY)}] : []),
    "You state only what the INSTRUCTION, the FIGURES or the FACTS say. Never invent a figure, a date, a price, a promise or a result. A number appears in the email only if it is written in the instruction, the figures or the facts, exactly as written there.",
    "The FIGURES were read for this email from this person's own account or from public data. Use them as given. You may say a figure in a plainer unit (731 cents is $7.31), never change its value.",
    "If the email would have to tell them something none of those contain (for example a figure that could not be read), do not write around it: set decision to cannot_write, leave subject and bodyHtml empty, and say in reason exactly what is missing.",
    who.strategy,
    ${JSON.stringify(RIGHT_MOMENT_STRATEGY)},
    ${JSON.stringify(NEXT_DATE_STRATEGY)},
    "STOP only on the person's OWN words, and only for two things: they asked us to stop, unsubscribe or never write again, or they show they are not a fit at all (the wrong person, they left the company). Then set decision to stop, leave subject, bodyHtml and nextFollowUpAt empty, and quote their words in reason. A plain \\"no thanks\\" or \\"not now\\" is not a stop: choose later, much later. Silence, or us having already answered them, is never a reason to stop.",
    "Write like a person who knows them: short, plain, warm, one idea per sentence. Greet them by first name when you have it. No sales pitch, no filler, no \\"I hope this finds you well\\".",
    "Never use an em dash or an en dash. Use a comma or a period.",
    "Do not sign off with a name or a signature block: ours is added below your text. End with your last sentence.",
    "bodyHtml is simple HTML: <p> paragraphs only. The subject is short and plain.",
  ].join("\\n");

  const message = [
    "NOW: " + new Date().toISOString(),
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "",
    "INSTRUCTION:",
    text || "(none: write from WHY WE WRITE NOW and where this person stands)",
    "",
    ...(whyNow.length ? ["WHY WE WRITE NOW:", ...whyNow, ""] : []),
    "WHO WE WRITE TO:",
    ...(personLines.length ? personLines : ["(nothing beyond their email)"]),
    "",
    "WHO THEY ARE TO US:",
    ...who.lines,
    "",
    "THE THREAD with this person, every channel, oldest first:",
    ...(who.olderMessagesOmitted > 0 ? ["(" + who.olderMessagesOmitted + " older messages not shown)"] : []),
    ...(who.threadLines.length ? who.threadLines : ["(no message ever exchanged)"]),
    ...(who.eventLines?.length ? ["", "RECENT EVENTS:", ...who.eventLines] : []),
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

${WHY_NOW_FN}
`.trim();

/**
 * Holds the model to its contract before anything is sent: a `write` with an empty subject or body is a broken
 * contract (throws), and any em/en dash is rewritten (between digits a hyphen, otherwise a comma). Builds the
 * one-step sequence and the send's idempotency key, which names the person's queue row.
 */
export const FINALIZE_EMAIL_CODE = `
export async function main(draft, followup, trigger) {
  const json = draft?.json ?? {};
  const rowId = followup?.followup?.id;
  if (!rowId) throw new Error("finalize-email: no claimed queue row");
  if (json.decision === "cannot_write") {
    console.error("[ai-follow-up-email] the instruction cannot be written from what we hold; nothing is sent. Missing: " +
      JSON.stringify(json.reason ?? null));
    return {
      decision: "cannot_write",
      reason: json.reason ?? null,
      delivery: { state: "refused", code: "${INSTRUCTION_NOT_WRITABLE_REASON}", reason: String(json.reason ?? "The email could not be written from what we hold.") },
    };
  }
  if (json.decision === "stop") {
    console.log("[ai-follow-up-email] the person's own words end the follow-ups: " + JSON.stringify(json.reason ?? null));
    return { decision: "stop", reason: String(json.reason ?? "") };
  }
  if (json.decision === "later") {
    const later = nextDate(json, "finalize-email");
    console.log("[ai-follow-up-email] not the right moment, nothing is sent; next look at " + later.nextFollowUpAt + ": " + later.nextFollowUpWhy);
    return { decision: "later", ...later, reason: String(json.reason ?? "") };
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
    // The occurrence when the run's trigger names this person (a redelivery re-dues the row, same event), else
    // the row and its due date: each follow-up of the same person is its own send.
    idempotencyKey: sendKey("ai-follow-up-email", followup.followup, trigger),
    ...nextDate(json, "finalize-email"),
  };
}

${OCCURRENCE_SEND_KEY_FN}

${NEXT_DATE_FN}
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

const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
  ...(inputMapping ? { inputMapping } : {}),
});

/** The claimed row, due again at the model's date with nothing sent (`scheduled`: not an action, the count stays). */
const scheduleAt = (id: string) => ({
  id,
  type: "http.call" as const,
  config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "scheduled" } },
  retries: 0,
  inputMapping: {
    "params.id": "$ref:claim-followup.output.followup.id",
    "body.dueAt": "$ref:finalize-email.output.nextFollowUpAt",
  },
});

/** The claimed row, stopped (not a tombstone: a fresh occurrence re-enters them). */
const stopRow = (id: string, reason: string) => ({
  id,
  type: "http.call" as const,
  config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "stopped", reason } },
  retries: 0,
  inputMapping: { "params.id": "$ref:claim-followup.output.followup.id" },
});

const WROTE = "results['finalize-email']?.decision == 'write' && results['send-email'] != null";
/** The email went out. */
export const SENT = `${WROTE} && results['send-email']?.skipped != true`;
/** Refused for a passing reason (a queued step of their sequence, a live thread): nothing sent, still followed up. */
export const DEFERRED = `${WROTE} && results['send-email']?.skipped == true && (${passingRefusal("send-email")})`;
/** Refused for good (opted out, not a prospect): the follow-ups end. */
export const REFUSED = `${WROTE} && results['send-email']?.skipped == true && !(${passingRefusal("send-email")})`;

export function buildAiFollowUpEmailDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      // What the run answers (a trigger occurrence, or nothing), and the trigger type's declaration.
      occurrencePlanNode(),
      triggerTypeNode(),
      // THIS campaign's own queue: it names its person, there is no predecessor. Every run asks it: a person is due
      // because an occurrence filed them, an instruction named them, or the follow-up date we set is reached.
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
        // A read: safe to retry. A sibling being redeployed (the box recreates containers every 5 min) is a
        // transport failure that the next attempt does not meet.
        retries: 2,
        inputMapping: {
          "body.question": "$ref:start-run.output.instruction",
          "body.recipientEmail": "$ref:claim-followup.output.followup.email",
          // No instruction (a run answering an occurrence alone): no question to read figures for.
          skip: "$ref:occurrence.output.skipFigures",
        },
      },
      // Who this person is to the brand (lead-service tags) and their whole merged thread (crm-service): the
      // shared step every writer runs before writing.
      ...personThreadNodes({
        email: "$ref:claim-followup.output.followup.email",
        brandId: "$ref:claim-followup.output.followup.brandId",
      }),
      relationshipReadNode({
        leadRowId: "$ref:claim-followup.output.followup.id",
        brandId: "$ref:claim-followup.output.followup.brandId",
      }),
      whoTheyAreNode({ relationshipRead: "$ref:relationship-read.output", timeline: "$ref:person-thread.output" }),
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
          who: "$ref:who-they-are.output",
          currentDate: "$ref:flow_input.currentDate",
          occurrence: "$ref:occurrence.output",
          triggerType: "$ref:trigger-type.output",
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
        inputMapping: {
          draft: "$ref:draft-email.output",
          followup: "$ref:claim-followup.output",
          trigger: "$ref:flow_input.trigger",
        },
      },
      // Converges (edge from claim-followup, outside check-claim's branch) so it is a top-level branchone.
      { id: "check-writable", type: "condition" },
      // A reply in the thread they wrote in last (`followUp: true`: the sender continues the brand's thread with
      // them, same mailbox, `Re:` its subject; a new thread only when we never emailed them). Lands in the Unibox.
      {
        id: "send-email",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/orgs/send",
          body: { type: "broadcast", tag: "ai-follow-up-email", followUp: true },
          validateResponse: { field: "success", equals: true },
          // Read, not thrown: an opted-out person, a step of their sequence still queued, or one the brand talks to
          // right now, is an outcome (check-sent).
          skipOnRefusalCodes: [...FOLLOW_UP_SEND_REFUSAL_CODES],
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
      { id: "check-sent", type: "condition" },
      // Strictly AFTER the send: acted, due again at the model's date (the queue row is the date's only store).
      {
        id: "record-sent",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "acted" } },
        retries: 0,
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "body.nextDueAt": "$ref:finalize-email.output.nextFollowUpAt",
        },
      },
      // Refused for a passing reason (nothing sent): still followed up at the model's date.
      scheduleAt("record-deferred"),
      // Not the right moment (we already answered them, the point was made): nothing sent, due again later.
      scheduleAt("record-later"),
      stopRow("record-refused", FOLLOW_UP_REFUSED_REASON),
      stopRow("record-stopped", FOLLOW_UP_STOPPED_REASON),
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
      // The occurrence's truth (PUSHED-TRUTH-1015): sent = delivered; any refusal the send skipped (passing or final)
      // = refused + the sender's code and sentence, so campaign-service never records a refused email as delivered.
      endRun("end-run", { success: true, stopCampaign: false, delivery: DELIVERED }),
      endRun("end-run-deferred", { success: true, stopCampaign: false }, refusedDelivery("send-email")),
      endRun("end-run-later", { success: true, stopCampaign: false }),
      endRun("end-run-stopped", { success: true, stopCampaign: false }),
      endRun("end-run-refused", { success: true, stopCampaign: false }, refusedDelivery("send-email")),
      // Failed (named in the log) but FINAL for the occurrence: a redelivery would only re-draft the same refusal.
      endRun("end-run-unwritable", { success: false, stopCampaign: false }, { "body.delivery": "$ref:finalize-email.output.delivery" }),
      // No email address: nothing read, nothing drafted, nothing sent; the row stopped with the reason.
      stopRow("release-no-email", NO_EMAIL_KNOWN_REASON),
      endRun("end-run-no-email", { success: true, stopCampaign: false, delivery: NO_EMAIL_DELIVERY }),
      // Nobody due is NOTHING TO DO, never a failure: campaign-service's scheduler runs every funnel unit on its
      // cadence with no trigger, and a failure here would back the unit off and skip its next real occurrence.
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "occurrence" },
      { from: "occurrence", to: "trigger-type" },
      { from: "trigger-type", to: "claim-followup" },
      { from: "claim-followup", to: "check-claim" },
      { from: "check-claim", to: "offer-economics", condition: `results['claim-followup']?.found == true && ${HAS_EMAIL}` },
      { from: "check-claim", to: "release-no-email", condition: `results['claim-followup']?.found == true && !(${HAS_EMAIL})` },
      { from: "release-no-email", to: "end-run-no-email" },
      { from: "check-claim", to: "end-run-nobody-due", condition: "results['claim-followup']?.found == false" },
      { from: "offer-economics", to: "brand-profile" },
      { from: "brand-profile", to: "lead-detail" },
      { from: "lead-detail", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "gather-facts" },
      { from: "gather-facts", to: "read-figures" },
      { from: "read-figures", to: "person-thread-query" },
      { from: "person-thread-query", to: "person-thread" },
      { from: "person-thread", to: "relationship-read" },
      { from: "relationship-read", to: "who-they-are" },
      { from: "who-they-are", to: "compose-email" },
      { from: "compose-email", to: "draft-email" },
      { from: "draft-email", to: "finalize-email" },
      { from: "finalize-email", to: "check-writable" },
      { from: "claim-followup", to: "check-writable" },
      { from: "check-writable", to: "send-email", condition: "results['finalize-email']?.decision == 'write'" },
      { from: "check-writable", to: "record-later", condition: "results['finalize-email']?.decision == 'later'" },
      { from: "check-writable", to: "record-stopped", condition: "results['finalize-email']?.decision == 'stop'" },
      { from: "check-writable", to: "release-unwritable", condition: "results['finalize-email']?.decision == 'cannot_write'" },
      { from: "record-later", to: "end-run-later" },
      { from: "record-stopped", to: "end-run-stopped" },
      { from: "send-email", to: "check-sent" },
      // Converges (edge from claim-followup) so it is a top-level branchone; every arm reads with `?.`.
      { from: "claim-followup", to: "check-sent" },
      { from: "check-sent", to: "record-sent", condition: SENT },
      { from: "check-sent", to: "record-deferred", condition: DEFERRED },
      { from: "check-sent", to: "record-refused", condition: REFUSED },
      { from: "record-sent", to: "end-run" },
      { from: "record-deferred", to: "end-run-deferred" },
      { from: "record-refused", to: "end-run-refused" },
      { from: "release-unwritable", to: "end-run-unwritable" },
    ],
    onError: "end-run-error",
  };
}
