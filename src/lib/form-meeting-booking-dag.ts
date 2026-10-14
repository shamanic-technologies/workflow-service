/**
 * The DAG of the `ai-meeting-booking|form_submitted_to_meeting_booked` pipe (Form submitted -> Meeting booked,
 * REACTIVE on the `form_submitted` trigger): a person filled a form in the brand's own CRM (GoHighLevel today,
 * any CRM the brand connects later, crm-service reports them all the same way), and within minutes we answer
 * their request, warmly and directly, and invite them to book a meeting.
 *
 * The channel's other workflows continue a THREAD (a positive reply to a cold email). This one STARTS one: the
 * person reached out first through a form and nobody has written to them yet. Hence its own DAG, beside them in the
 * same channel, registered on its own pipe.
 *
 * How the person gets here: crm-service reports each new submission to campaign-service's generic trigger door
 * (`form_submitted`, the same door every reactive trigger uses). campaign-service files the person on the funnel
 * campaign's own lead-service follow-up queue, due now, and dispatches this workflow with the event as
 * `flow_input.trigger` (`{ eventId, triggerId, leadId, person: { email, name, phone, crmContact }, item }`, `item` being
 * crm-service's occurrence verbatim: `{ source, submissionId, formId, formName, submittedAt, answers, crmContactId }`).
 * A form event is filed and made due ONLY right before its own dispatch, so the run that claims the person is the run
 * carrying their trigger.
 *
 * One run answers EXACTLY ONE person:
 *
 *  - The person is CLAIMED from this campaign's own queue (`claim-next`, atomic, at most one, exactly once), like
 *    every reactive campaign, so two runs never answer the same person. Nobody due ends the run idle.
 *  - Their form (name, answers, submission time) is read off `flow_input.trigger`, and ONLY when the trigger names
 *    the person claimed (email, case-folded): a run carrying another person's form never writes from it. A claimed
 *    person whose form this run does not carry is still answered (they asked us something through the form), and
 *    the log says their answers were not available.
 *  - The answer is written by the model through chat-service `/complete` (which owns the model, the key and the
 *    cost declaration) from THE GAME (answer what they asked, plainly, then invite them to book), the form, what
 *    the CLIENT told us about the offer (`GATHER_FACTS_CODE`, never the website), and the offer's booking link.
 *    The model may decide `no_reply_owed` only for a submission that is plainly not a person asking (a test, spam):
 *    nothing is sent and the row says why.
 *  - The email goes out as a NEW thread through email-gateway's broadcast send (Instantly, our sending infra), so
 *    their answer lands in the Unibox. Both sends' idempotency keys name the OCCURRENCE (`trigger.eventId`) when the
 *    run's trigger names the claimed person: campaign-service redelivers the same occurrence after a run that did
 *    not complete (sent, then failed later), re-filing the person with a NEW due date, and the redelivered run must
 *    send nothing new. A new form fill is a new occurrence, so it is answered. A run whose trigger does not name the
 *    claimed person keys on the queue row and its due date.
 *  - A send email-gateway REFUSES for this person (`lead_opted_out`, `recent_brand_contact`: they asked us to stop,
 *    or the brand is already talking with them) sends nothing on any channel and stops the row with that reason,
 *    named in the log, so the queue never hands them out again for this form.
 *  - Strictly AFTER the email, the row is marked `stopped` (`form_answered`): nothing more is owed now, and it is
 *    not a tombstone, so the same person filling a form again next month is answered again.
 *  - Then, the same answer in a few words on WhatsApp from the brand's own linked number (crm-service owns the
 *    account and the send). A brand with no WhatsApp linked, or a person with no WhatsApp, is a named refusal that
 *    ends nothing: the email already went.
 *
 * No em dash or en dash ever reaches the person: the prompt bans them and `finalize-answer` rewrites any that slip
 * through, before the send.
 */
import type { DAG } from "./dag-validator.js";
import { CHAT_STEP_MAX_TOKENS, GATHER_FACTS_CODE } from "./ai-meeting-booking-dag.js";
import { personThreadNodes, relationshipReadNode, whoTheyAreNode } from "./person-relationship.js";
import { CRM_WHATSAPP_SEND, WHATSAPP_REFUSAL_CODES } from "./cold-whatsapp-outreach-dag.js";
import { REFUSAL_SKIP_CODES } from "./dag-to-openflow.js";

export const FORM_MEETING_BOOKING_FEATURE_SLUG = "ai-meeting-booking";

/** The leg this pipe performs (features-service catalogue, 2026-10-12). */
export const FORM_MEETING_BOOKING_LEG_KEY = "form_submitted_to_meeting_booked";

export const FORM_MEETING_BOOKING_PIPE_ID = `${FORM_MEETING_BOOKING_FEATURE_SLUG}|${FORM_MEETING_BOOKING_LEG_KEY}`;

export const FORM_MEETING_BOOKING_DESCRIPTION =
  "Answers a person who just filled a form in the brand's CRM, within minutes: a short, warm, direct answer to " +
  "what they asked, written from their form answers and what the client told us, inviting them to book a meeting " +
  "with the brand's booking link. Sent by email as a new thread, and on WhatsApp too when the brand has it linked.";

/** The model the answer is written with, through chat-service. Always-thinking: no temperature. */
export const FORM_MEETING_BOOKING_LLM = { provider: "anthropic", model: "opus" } as const;

/** Stored on the person's queue row once the answer went out: stopped, so a new form fill is answered again. */
export const FORM_ANSWERED_REASON = "form_answered";

/** Stored when email-gateway refused the email for this person (opted out, or already in a thread with the brand). */
export const FORM_EMAIL_REFUSED_REASON = "form_email_refused";

/** Stored when the submission is plainly not a person asking (a test, spam): nothing was sent. */
export const FORM_NO_REPLY_OWED_REASON = "form_no_reply_owed";

export const ANSWER_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    decision: { type: "string", enum: ["answer", "no_reply_owed"] },
    subject: { type: "string", description: "The email subject line. Empty when decision is no_reply_owed." },
    bodyHtml: { type: "string", description: "The email body as simple HTML paragraphs. Empty when decision is no_reply_owed." },
    whatsappText: {
      type: "string",
      description: "The same answer as a short WhatsApp message, plain text. Empty when decision is no_reply_owed.",
    },
    reason: { type: "string", description: "One sentence: what the answer does, or why no reply is owed." },
  },
  required: ["decision", "subject", "bodyHtml", "whatsappText", "reason"],
} as const;

/**
 * Who this run answers and what they asked. The person is the CLAIMED row; the form comes from the trigger only
 * when the trigger names that same person.
 */
export const RESOLVE_FORM_CODE = `
export async function main(claim, trigger, leadDetail) {
  const f = claim?.followup ?? {};
  if (!f.id || !f.email) throw new Error("resolve-form: a claimed row carries no id or email");
  const fold = (s) => typeof s === "string" ? s.trim().toLowerCase() : null;
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const matches = !!t && fold(t.person?.email) !== null && fold(t.person?.email) === fold(f.email);
  const raw = matches ? (t.item ?? null) : null;
  const form = raw && typeof raw === "object"
    ? {
        formName: typeof raw.formName === "string" && raw.formName.trim() ? raw.formName.trim() : null,
        submittedAt: raw.submittedAt ?? null,
        answers: Array.isArray(raw.answers) ? raw.answers : [],
      }
    : null;
  if (!form) {
    console.error("[form-meeting-booking] " + String(f.email) + " is answered without their form answers: " +
      (t ? "this run's trigger names " + String(t.person?.email ?? "nobody") + (matches ? " but carries no form" : "") : "this run carries no trigger"));
  }
  const lead = leadDetail?.leadDetail?.lead ?? {};
  const present = (v) => typeof v === "string" && v.trim() !== "";
  const fullName = matches && present(t.person?.name)
    ? t.person.name.trim()
    : [lead.firstName, lead.lastName].filter(present).join(" ") || null;
  return {
    rowId: f.id,
    leadId: f.leadId ?? null,
    email: f.email,
    brandId: f.brandId ?? null,
    dueAt: f.dueAt ?? null,
    fullName,
    firstName: present(lead.firstName) ? lead.firstName.trim() : (fullName ? fullName.split(/\\s+/)[0] : null),
    eventId: matches ? (t.eventId ?? null) : null,
    form,
  };
}
`.trim();

/**
 * Builds the system prompt and the message. chat-service `/complete` takes one flat `message`, so the
 * interpolation happens in the flow; this is also what makes the prompt readable in the stored DAG.
 * The strategy is explained to the model, never a script per case (owner rule).
 */
export const COMPOSE_ANSWER_PROMPT_CODE = `
export async function main(person, offer, brand, rep, facts, currentDate, who) {
  if (!who || !Array.isArray(who.lines) || !Array.isArray(who.threadLines) || typeof who.strategy !== "string") {
    throw new Error("compose-answer: who this person is to the brand was not read; nothing is written blind");
  }
  const offerName = typeof offer?.name === "string" ? offer.name.trim() : "";
  if (!offerName) throw new Error("compose-answer: the campaign's offer read carries no name");
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose-answer: the brand read carries no name");
  if (!person?.email) throw new Error("compose-answer: no person to answer");

  const present = (v) => typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined;
  const bookingUrl = present(offer?.bookingUrl) ? String(offer.bookingUrl).trim() : null;
  const senderName = present(rep?.salesRepFirstName) ? rep.salesRepFirstName.trim() : null;
  const exact = facts?.exact ?? [];
  const neverGive = facts?.neverGive ?? [];
  const form = person.form;
  const answerLine = (a) => {
    const label = present(a?.label) ? a.label.trim() : String(a?.key ?? "field");
    const value = Array.isArray(a?.value) ? a.value.join(", ") : String(a?.value ?? "");
    return "- " + label + ": " + value;
  };

  const systemPrompt = [
    "You answer ONE person who just filled a form to reach " + brandName + ". This is the first thing they get back from us about this form, a few minutes after they asked. THE THREAD below shows whether we already talked with them before, on any channel: if we did, they are not new, so pick that relationship up rather than greeting them like a stranger.",
    who.strategy,
    "OPEN WITH WHAT THEY DID: your first sentence tells them, in plain words, that this answers the form they just filled in to reach " + brandName + ", so they know at once why we write (a vague \\"thanks for reaching out\\" does not). Name the form when its name means something to a person (\\"Meta Ads\\" = the form on our Facebook or Instagram ad; \\"Post a job\\" = our Post a job form); leave a code-like name out. Say where the form was (an ad, the website) only when its name says so; never invent it. The WhatsApp text opens the same way.",
    "THE GAME: they raised their hand. Most people who fill a form and hear nothing for a day go elsewhere; the ones answered within minutes, by a person who read what they wrote, book. So: answer what they asked or said in the form, directly and in their own words where you can, show you read it, then invite them to book a meeting so the team can help them properly. One clear next step, never several.",
    bookingUrl
      ? "The booking link is " + bookingUrl + ". Give it once, plainly, as the way to pick a time."
      : "There is no booking link. Ask them to reply with a day and time that suits them for a short call.",
    "You write on behalf of " + brandName + ". Name " + brandName + " when you speak of the business; say \\"we\\" only for the team handling their request. Never say you are an agency or a third party.",
    "State only what the FORM, the FACTS or the booking link say. Never invent a price, a date, a promise, a result or an availability. A question the facts do not answer is one for the meeting: say the team will cover it there, warmly, without apologising.",
    "Write like a person who is glad they reached out: short, plain, warm, one idea per sentence. Greet them by first name when you have it. No sales pitch, no filler, no \\"I hope this finds you well\\", no \\"thank you for your submission\\".",
    "English only. Never use an em dash or an en dash. Use a comma or a period.",
    "Email: bodyHtml is simple HTML, <p> paragraphs only, under 120 words. Do not sign off with a name or a signature block: ours is added below your text. The subject is short and plain, about their request.",
    "WhatsApp: whatsappText is the same answer in 2 or 3 short sentences, plain text, with the booking link if there is one." + (senderName ? " End it with " + senderName + " on its own." : " Do not sign it with a made-up name."),
    "Decision no_reply_owed ONLY when the submission is plainly not a person asking anything (a test entry, spam, gibberish). Then leave subject, bodyHtml and whatsappText empty. A short form with only a name and an email IS a person asking: answer it. A name that differs from the email address, or a request outside the offer, is NOT a reason either: real people do both, so answer them.",
  ].join("\\n");

  const message = [
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "",
    "WHO FILLED THE FORM:",
    "Email: " + person.email,
    ...(present(person.fullName) ? ["Name: " + person.fullName] : []),
    "",
    form
      ? "THEIR FORM" + (form.formName ? " (\\"" + form.formName + "\\")" : "") + (form.submittedAt ? ", sent " + String(form.submittedAt) : "") + ":"
      : "THEIR FORM: (their answers are not available to us; answer their request to " + brandName + " in general and invite them to book)",
    ...(form ? (form.answers.length ? form.answers.map(answerLine) : ["(no answers beyond their contact details)"]) : []),
    "",
    "WHO THEY ARE TO US:",
    ...who.lines,
    "",
    "THE THREAD with this person before this form, every channel, oldest first:",
    ...(who.olderMessagesOmitted > 0 ? ["(" + who.olderMessagesOmitted + " older messages not shown)"] : []),
    ...(who.threadLines.length ? who.threadLines : ["(no message ever exchanged)"]),
    ...(who.eventLines?.length ? ["", "RECENT EVENTS:", ...who.eventLines] : []),
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
 * Holds the model to its contract before anything is sent: an `answer` with an empty subject, body or WhatsApp
 * text is a broken contract (throws), and any em/en dash is rewritten (between digits a hyphen, otherwise a comma).
 * Builds the one-step sequence and the sends' idempotency keys, which name the OCCURRENCE answered (its eventId,
 * when the run's trigger names the claimed person), else the queue row and its due date.
 */
export const FINALIZE_ANSWER_CODE = `
export async function main(draft, person) {
  const json = draft?.json ?? {};
  if (!person?.rowId) throw new Error("finalize-answer: no claimed queue row");
  if (json.decision === "no_reply_owed") {
    console.error("[form-meeting-booking] no reply owed to " + String(person.email) + ": " + JSON.stringify(json.reason ?? null));
    return { decision: "no_reply_owed", reason: json.reason ?? null };
  }
  if (json.decision !== "answer") throw new Error("finalize-answer: unknown decision " + JSON.stringify(json.decision));
  const undash = (s) => String(s ?? "")
    .replace(/&(mdash|ndash);|&#(8212|8211|x2014|x2013);/gi, (m) => (/mdash|8212|2014/i.test(m) ? "\\u2014" : "\\u2013"))
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  const subject = undash(json.subject);
  const bodyHtml = undash(json.bodyHtml);
  const whatsappText = undash(json.whatsappText);
  if (!subject || !bodyHtml || !whatsappText) throw new Error("finalize-answer: decision answer with an empty subject, body or WhatsApp text");
  if (subject !== String(json.subject ?? "").trim() || bodyHtml !== String(json.bodyHtml ?? "").trim() || whatsappText !== String(json.whatsappText ?? "").trim()) {
    console.error("[form-meeting-booking] the draft used a dash the person must never read; rewritten before the send");
  }
  // The occurrence this run answers names the send: campaign-service redelivers the SAME eventId after a run
  // that sent and then failed, re-filing the person with a NEW due date, so a row+due key would answer twice.
  // A run whose trigger does not name the claimed person (no eventId on resolve-form) keys on the row and its due date.
  const key = person.eventId
    ? "form-meeting-booking:event:" + String(person.eventId)
    : "form-meeting-booking:" + person.rowId + ":" + String(person.dueAt ?? "");
  return {
    decision: "answer",
    subject,
    sequence: [{ step: 1, bodyHtml, daysSinceLastStep: 0 }],
    whatsappText,
    idempotencyKey: key,
    whatsappIdempotencyKey: key + ":whatsapp",
  };
}
`.trim();

const GATHER_FACTS_SIGNATURE = "export async function main(plan, offerAnswers, offerFields, brandFields)";
if (!GATHER_FACTS_CODE.startsWith(GATHER_FACTS_SIGNATURE)) {
  throw new Error("form-meeting-booking: GATHER_FACTS_CODE changed its signature; re-wrap it");
}

/** `ai-meeting-booking`'s fact gathering, unchanged, with no question list: the form is the ask. */
export const GATHER_CLIENT_FACTS_CODE =
  GATHER_FACTS_CODE.replace(GATHER_FACTS_SIGNATURE, "async function gatherFacts(plan, offerAnswers, offerFields, brandFields)") +
  "\n\nexport async function main(offerAnswers, offerFields, brandFields) {\n" +
  "  return gatherFacts(null, offerAnswers, offerFields, brandFields);\n}";

const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
});

const PERSON_BRAND = "$ref:resolve-form.output.brandId";

/** The email went out: the decision was to answer AND the send returned without a refusal. */
export const SENT = "results['finalize-answer']?.decision == 'answer' && results['send-email'] != null && results['send-email']?.skipped != true";
/** email-gateway refused the email for this person. */
export const REFUSED = "results['finalize-answer']?.decision == 'answer' && results['send-email']?.skipped == true";

export function buildFormMeetingBookingDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      // THIS campaign's own queue: campaign-service made the form person due on it before the dispatch.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId" },
      },
      { id: "check-claim", type: "condition" },
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
        id: "resolve-form",
        type: "script",
        config: { code: RESOLVE_FORM_CODE },
        retries: 0,
        inputMapping: {
          claim: "$ref:claim-followup.output",
          trigger: "$ref:flow_input.trigger",
          leadDetail: "$ref:lead-detail.output",
        },
      },
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
        inputMapping: { "params.id": PERSON_BRAND },
      },
      // Who signs the WhatsApp: the brand's stated rep, who answers on that number.
      {
        id: "sales-rep",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/sales-rep" },
        inputMapping: { "params.brandId": PERSON_BRAND },
      },
      {
        id: "offer-answers",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers" },
        inputMapping: { "params.brandId": PERSON_BRAND, "params.offerId": "$ref:start-run.output.offerId" },
      },
      {
        id: "offer-user-fields",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields" },
        inputMapping: { "params.brandId": PERSON_BRAND, "params.offerId": "$ref:start-run.output.offerId" },
      },
      {
        id: "brand-user-fields",
        type: "http.call",
        // Refused (409 SEVERAL_OFFERS) for a brand selling several offers: gather-facts reads that one
        // refusal as "no brand-level fields" and re-throws every other failure.
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", tolerateFailure: true },
        inputMapping: { "params.brandId": PERSON_BRAND },
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
      // Who this person is to the brand (lead-service tags) and their whole merged thread (crm-service): the
      // shared step every writer runs before writing.
      ...personThreadNodes({ email: "$ref:resolve-form.output.email", brandId: "$ref:resolve-form.output.brandId" }),
      relationshipReadNode({
        leadRowId: "$ref:claim-followup.output.followup.id",
        brandId: "$ref:claim-followup.output.followup.brandId",
      }),
      whoTheyAreNode({ relationshipRead: "$ref:relationship-read.output", timeline: "$ref:person-thread.output" }),
      {
        id: "compose-answer",
        type: "script",
        config: { code: COMPOSE_ANSWER_PROMPT_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:resolve-form.output",
          offer: "$ref:offer-economics.output",
          brand: "$ref:brand-profile.output",
          rep: "$ref:sales-rep.output",
          facts: "$ref:gather-facts.output",
          who: "$ref:who-they-are.output",
          currentDate: "$ref:flow_input.currentDate",
        },
      },
      {
        id: "draft-answer",
        type: "http.call",
        config: {
          service: "chat",
          method: "POST",
          path: "/complete",
          body: {
            provider: FORM_MEETING_BOOKING_LLM.provider,
            model: FORM_MEETING_BOOKING_LLM.model,
            responseFormat: "json",
            responseSchema: ANSWER_RESPONSE_SCHEMA,
            maxTokens: CHAT_STEP_MAX_TOKENS,
          },
        },
        retries: 0,
        inputMapping: {
          "body.message": "$ref:compose-answer.output.message",
          "body.systemPrompt": "$ref:compose-answer.output.systemPrompt",
        },
      },
      {
        id: "finalize-answer",
        type: "script",
        config: { code: FINALIZE_ANSWER_CODE },
        retries: 0,
        inputMapping: { draft: "$ref:draft-answer.output", person: "$ref:resolve-form.output" },
      },
      // Converges (edge from claim-followup, outside check-claim's branch) so it is a top-level branchone.
      { id: "check-decision", type: "condition" },
      // A NEW thread from our sending infra: lands in the Unibox, the reply is threaded there.
      {
        id: "send-email",
        type: "http.call",
        config: {
          service: "email-gateway",
          method: "POST",
          path: "/orgs/send",
          body: { type: "broadcast", tag: "form-meeting-booking" },
          validateResponse: { field: "success", equals: true },
          // Read, not thrown: an opted-out person or one the brand already talks to is an outcome (check-sent).
          skipOnRefusalCodes: [...REFUSAL_SKIP_CODES],
        },
        retries: 0,
        inputMapping: {
          "body.to": "$ref:resolve-form.output.email",
          "body.subject": "$ref:finalize-answer.output.subject",
          "body.sequence": "$ref:finalize-answer.output.sequence",
          "body.idempotencyKey": "$ref:finalize-answer.output.idempotencyKey",
          "body.leadId": "$ref:resolve-form.output.leadId",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.workflowSlug": "$ref:start-run.output.workflowSlug",
          "body.timezone": "$ref:lead-detail.output.leadDetail.lead.timezone",
        },
      },
      // Converges (edge from claim-followup) so it is top level; reads positive evidence of each outcome.
      { id: "check-sent", type: "condition" },
      {
        id: "record-refused",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: FORM_EMAIL_REFUSED_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:resolve-form.output.rowId" },
      },
      // Strictly AFTER the email. Stopped, not handed: a new form fill by the same person is answered again.
      {
        id: "record-answered",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: FORM_ANSWERED_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:resolve-form.output.rowId" },
      },
      // The same answer on WhatsApp, from the brand's own linked number. Its named refusals end nothing.
      {
        id: "send-whatsapp",
        type: "http.call",
        config: { ...CRM_WHATSAPP_SEND, skipOnRefusalCodes: [...WHATSAPP_REFUSAL_CODES] },
        retries: 0,
        inputMapping: {
          "body.email": "$ref:resolve-form.output.email",
          "body.brandId": "$ref:resolve-form.output.brandId",
          "body.text": "$ref:finalize-answer.output.whatsappText",
          "body.idempotencyKey": "$ref:finalize-answer.output.whatsappIdempotencyKey",
        },
      },
      {
        id: "record-no-reply",
        type: "http.call",
        config: {
          service: "lead",
          method: "POST",
          path: "/orgs/leads/{id}/followups",
          body: { kind: "stopped", reason: FORM_NO_REPLY_OWED_REASON },
        },
        retries: 0,
        inputMapping: { "params.id": "$ref:resolve-form.output.rowId" },
      },
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-no-reply", { success: true, stopCampaign: false }),
      endRun("end-run-refused", { success: true, stopCampaign: false }),
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "claim-followup" },
      { from: "claim-followup", to: "check-claim" },
      { from: "check-claim", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      { from: "check-claim", to: "end-run-nobody-due", condition: "results['claim-followup']?.found != true" },
      { from: "lead-detail", to: "resolve-form" },
      { from: "resolve-form", to: "offer-economics" },
      { from: "offer-economics", to: "brand-profile" },
      { from: "brand-profile", to: "sales-rep" },
      { from: "sales-rep", to: "offer-answers" },
      { from: "offer-answers", to: "offer-user-fields" },
      { from: "offer-user-fields", to: "brand-user-fields" },
      { from: "brand-user-fields", to: "gather-facts" },
      { from: "gather-facts", to: "person-thread-query" },
      { from: "person-thread-query", to: "person-thread" },
      { from: "person-thread", to: "relationship-read" },
      { from: "relationship-read", to: "who-they-are" },
      { from: "who-they-are", to: "compose-answer" },
      { from: "compose-answer", to: "draft-answer" },
      { from: "draft-answer", to: "finalize-answer" },
      { from: "finalize-answer", to: "check-decision" },
      { from: "claim-followup", to: "check-decision" },
      { from: "check-decision", to: "send-email", condition: "results['finalize-answer']?.decision == 'answer'" },
      { from: "check-decision", to: "record-no-reply", condition: "results['finalize-answer']?.decision == 'no_reply_owed'" },
      { from: "send-email", to: "check-sent" },
      { from: "claim-followup", to: "check-sent" },
      { from: "check-sent", to: "record-answered", condition: SENT },
      { from: "check-sent", to: "record-refused", condition: REFUSED },
      { from: "record-refused", to: "end-run-refused" },
      { from: "record-answered", to: "send-whatsapp" },
      { from: "send-whatsapp", to: "end-run" },
      { from: "record-no-reply", to: "end-run-no-reply" },
    ],
    onError: "end-run-error",
  };
}
