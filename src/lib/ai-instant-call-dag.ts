/**
 * THE WORKFLOW OF THE AI INSTANT CALL PIPE (AIC-COMMON-1015, owner 2026-10-15: the call is placed by the pipe's
 * workflow, never as a side effect inside another service). Same shape as every reactive pipe (the form DAG of
 * `ai-meeting-booking` is its closest sibling): campaign-service dispatches it when the pipe's trigger fires, the run
 * claims the ONE person the occurrence made due on the unit's own follow-up queue, and rings the brand's sales rep
 * about them.
 *
 * The pipe is `ai-instant-call|conversation_to_booking_call`. Two occurrences ring the rep, read off
 * `flow_input.trigger` (`{ eventId, triggerId, leadId, person, item }`):
 *
 *  - A FORM FILL (`form_submitted`, pushed by crm-service): `person: {email, name, phone, ...}`,
 *    `item: {formName, submittedAt, answers: [{key, label, value}]}`. The call says a form was filled (twilio-service
 *    `occasion: {type: "form", formName, answers}`), reads the answers after the accept keypress, and bridges to the
 *    phone the person gave in the form.
 *  - A POSITIVE REPLY (`positive_reply_received`, pushed by instantly-service): `person: {email, name}`,
 *    `item: {replyText, priorMessages}` where `replyText` is what they wrote, already stripped of quoted history and
 *    our signature, and `priorMessages` the earlier messages of the thread, NEWEST-FIRST, entry 0 being the email the
 *    reply answers, each `{direction: "outbound" | "inbound", text}` already stripped the same way (at most 5 are
 *    read). The call says exactly what it always said: who replied, the reply, the thread walkable by keypress.
 *    A reply whose words we do not hold is still rung, and the call SAYS the words are unavailable.
 *
 * One run rings about EXACTLY ONE person, at most once per occurrence:
 *
 *  - Only a run CARRYING an occurrence that names a person claims anyone (campaign-service also dispatches reactive
 *    units on a schedule with no trigger: idle). A run that claims nobody ends idle (`noWorkAvailable`), rings
 *    nobody: this is also what every positive reply does until instantly-service pushes the occurrence.
 *  - The occurrence is used ONLY when it names the claimed person (email, case-folded). Claimed someone else: their
 *    row is left alone, nobody rung, the run fails so this occurrence is redelivered.
 *  - A brand with no sales rep phone wants no call: the row is stopped (`no_sales_rep_phone`), the run ends cleanly.
 *  - The number to bridge to: the phone the occurrence carries (a form always does: the person gave it), else, for an
 *    Apollo-sourced prospect, Apollo's phone reveal waited for at most 90 s (`pollWhile` on `http.call`; a number
 *    flagged do-not-call is announced, never dialled), else none, and the call says it cannot connect them. No
 *    number is ever invented.
 *  - The call (twilio-service `POST /calls`) is a child of THIS run (`parentRunId`, plus the identity headers every
 *    node carries), so its minutes and the reveal land on the unit's run tree like every pipe's spend. Its
 *    idempotency key names the occurrence (`ai-instant-call:event:<eventId>`). Nothing after the call may fail the
 *    run (the record is tolerated): campaign-service redelivers a failed run's occurrence, and a redelivered run must
 *    never ring twice.
 *  - Strictly AFTER the call, the row is `stopped` (`instant_call_placed`): not a tombstone, so the next occurrence
 *    for the same person rings again.
 */
import type { DAG } from "./dag-validator.js";

export const AI_INSTANT_CALL_FEATURE_SLUG = "ai-instant-call";

/** The leg the AI Instant Call pipe performs (Positive reply -> Booking call). */
export const AI_INSTANT_CALL_LEG_KEY = "conversation_to_booking_call";

export const AI_INSTANT_CALL_PIPE_ID = `${AI_INSTANT_CALL_FEATURE_SLUG}|${AI_INSTANT_CALL_LEG_KEY}`;

export const AI_INSTANT_CALL_DESCRIPTION =
  "Rings the brand's sales rep the moment a prospect replies with interest or fills in a form: says who it is and " +
  "what they wrote or answered, and connects the rep to them on a keypress when we have their number (the phone " +
  "they gave, or one Apollo reveals within 90 seconds). A positive reply occurrence carries item {replyText, " +
  "priorMessages: [{direction: outbound|inbound, text}] newest-first}; a form occurrence carries item {formName, " +
  "answers}. One call per person per occurrence, nobody due = no call.";

/** How long the call waits for Apollo to deliver the number before ringing anyway. */
export const PHONE_REVEAL_WAIT_SECONDS = 90;
export const PHONE_REVEAL_POLL_SECONDS = 5;

/** How many earlier messages the call offers to walk back through (as before, in instantly-service). */
export const MAX_PRIOR_MESSAGES = 5;

/** Spoken in place of the reply when its words cannot be read (instantly-service's wording, unchanged). */
export const REPLY_TEXT_UNAVAILABLE = "their reply is not available to read out on this call.";

/** Stored on the queue row once the call was placed: stopped, so the next occurrence rings again. */
export const INSTANT_CALL_PLACED_REASON = "instant_call_placed";

/** Stored when the brand states no sales rep phone: nobody rung. */
export const NO_SALES_REP_PHONE_REASON = "no_sales_rep_phone";

/** Whether this run carries an occurrence naming someone: a run that does not claims nobody. Pure. */
export const PLAN_CLAIM_CODE = `
export async function main(trigger) {
  const email = trigger && typeof trigger === "object" ? trigger.person?.email : null;
  const carries = typeof email === "string" && email.trim() !== "";
  if (!carries) console.log("[ai-instant-call] this run carries no occurrence naming a person: nobody is claimed");
  return { skip: !carries };
}
`.trim();

/**
 * The claimed person, what they did (a form fill or a reply), who they are, and whether the call can be placed and
 * needs a reveal. Never throws for a missing piece: the call says less instead (absent fields are OMITTED, never
 * sent empty). `ok: false` when the occurrence names someone else.
 */
export const RESOLVE_CALL_CODE = `
export async function main(claim, trigger, leadDetail, rep, brand) {
  const f = claim?.followup ?? {};
  if (!f.id || !f.email) throw new Error("resolve-call: a claimed row carries no id or email");
  const fold = (s) => typeof s === "string" ? s.trim().toLowerCase() : null;
  const said = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
  const t = trigger && typeof trigger === "object" ? trigger : null;
  if (!t || fold(t.person?.email) === null || fold(t.person?.email) !== fold(f.email)) {
    console.error("[ai-instant-call] nobody rung about " + String(f.email) + ": this run's occurrence names " + String(t?.person?.email ?? "nobody"));
    return { ok: false, rowId: f.id, email: f.email };
  }
  const item = t.item && typeof t.item === "object" ? t.item : {};

  const d = leadDetail && leadDetail.ok !== false ? (leadDetail.leadDetail ?? null) : null;
  if (leadDetail?.ok === false) console.error("[ai-instant-call] the lead read failed for " + String(f.email) + ": rung about who the occurrence names");
  const lead = d?.lead ?? {};
  const org = lead.organization ?? {};
  const name = said(lead.name) ?? (said(lead.firstName) || said(lead.lastName) ? [said(lead.firstName), said(lead.lastName)].filter(Boolean).join(" ") : undefined) ?? said(t.person?.name) ?? f.email;
  const reply = { name };
  const put = (k, v) => { const x = said(v); if (x) reply[k] = x; };
  put("company", org.name ?? d?.company?.name);
  put("firstName", lead.firstName);
  put("lastName", lead.lastName);
  put("title", lead.currentTitle);
  put("city", lead.city);
  put("state", lead.state);
  put("country", lead.country);

  // What they did: a form (its answers) or a reply (its words and the thread it answers).
  const isForm = Array.isArray(item.answers) || said(item.formName) !== undefined;
  let occasion = null;
  let priorMessages = [];
  if (isForm) {
    const answers = (Array.isArray(item.answers) ? item.answers : [])
      .map((a) => ({
        question: said(a?.label) ?? said(a?.key) ?? "",
        answer: Array.isArray(a?.value) ? a.value.map(String).join(", ").trim() : (a?.value === null || a?.value === undefined ? "" : String(a.value).trim()),
      }))
      .filter((a) => a.question && a.answer);
    occasion = {
      type: "form",
      formName: said(item.formName) ?? "a form",
      answers: answers.length ? answers : [{ question: "Answers", answer: "none beyond their contact details" }],
    };
  } else {
    reply.message = said(item.replyText) ?? ${JSON.stringify(REPLY_TEXT_UNAVAILABLE)};
    if (!said(item.replyText)) console.error("[ai-instant-call] the occurrence carries no reply text for " + String(f.email) + ": the call says it is unavailable");
    priorMessages = (Array.isArray(item.priorMessages) ? item.priorMessages : [])
      .filter((m) => (m?.direction === "outbound" || m?.direction === "inbound") && said(m?.text))
      .slice(0, ${MAX_PRIOR_MESSAGES})
      .map((m) => ({ direction: m.direction, text: m.text.trim() }));
  }

  const salesRepPhone = said(rep?.salesRepPhone) ?? null;
  const knownPhone = said(t.person?.phone) ?? null;
  const apolloPersonId = said(d?.apolloPersonId) ?? said(lead.apolloPersonId) ?? null;
  const needsReveal = !!salesRepPhone && !knownPhone && !!apolloPersonId;
  return {
    ok: true,
    rowId: f.id,
    email: f.email,
    brandId: f.brandId ?? null,
    eventId: t.eventId ?? null,
    hasRep: !!salesRepPhone,
    salesRepPhone,
    brandName: said(brand?.brand?.name) ?? null,
    reply,
    occasion,
    priorMessages,
    knownPhone,
    apolloPersonId,
    needsReveal,
    skipReveal: !needsReveal,
  };
}
`.trim();

/**
 * The body of the call. The number to bridge to is the occurrence's phone, else a revealed one that is found and not
 * do-not-call, else none (the call says so). The idempotency key names the occurrence.
 */
export const BUILD_CALL_CODE = `
export async function main(person, reveal, campaignId, runId) {
  if (!person?.ok || !person.salesRepPhone) throw new Error("build-call: no person or no rep phone to ring");
  const r = reveal && reveal.ok !== false && !reveal.notCalled ? reveal : null;
  const revealed = r && r.status === "found" && r.doNotCall !== true && typeof r.mobilePhone === "string" && r.mobilePhone.trim() ? r.mobilePhone.trim() : null;
  const connectTo = person.knownPhone ?? revealed;
  if (person.needsReveal) {
    console.log("[ai-instant-call] reveal for " + String(person.email) + ": " + (r ? String(r.status) + (r.doNotCall ? " (do-not-call, never dialled)" : "") + (r.pollTimedOut ? " (wait ran out)" : "") : "failed"));
  }
  const body = {
    to: person.salesRepPhone,
    reply: person.reply,
    ...(person.occasion ? { occasion: person.occasion } : {}),
    ...(person.brandName ? { brandName: person.brandName } : {}),
    ...(connectTo ? { connectTo } : {}),
    ...(!person.occasion && person.priorMessages.length ? { priorMessages: person.priorMessages } : {}),
    ...(runId ? { parentRunId: runId } : {}),
    ...(person.brandId ? { brandId: person.brandId } : {}),
    ...(campaignId ? { campaignId } : {}),
    idempotencyKey: person.eventId ? "ai-instant-call:event:" + String(person.eventId) : "ai-instant-call:" + String(person.rowId),
  };
  console.log("[ai-instant-call] ringing the rep about " + String(person.email) + " (" + (person.occasion ? "form" : "reply") + "), connect " + (connectTo ? "offered" : "not offered"));
  return { body, connectOffered: !!connectTo };
}
`.trim();

const endRun = (id: string, body: Record<string, unknown>) => ({
  id,
  type: "http.call" as const,
  config: { service: "campaign", method: "POST", path: "/end-run", body },
});

const stopRow = (id: string, reason: string, tolerateFailure = false) => ({
  id,
  type: "http.call" as const,
  config: {
    service: "lead",
    method: "POST",
    path: "/orgs/leads/{id}/followups",
    body: { kind: "stopped", reason },
    ...(tolerateFailure ? { tolerateFailure: true } : {}),
  },
  retries: 0,
  inputMapping: { "params.id": "$ref:resolve-call.output.rowId" },
});

const PERSON_BRAND = "$ref:claim-followup.output.followup.brandId";

/** A run carrying no occurrence, or one whose person is not due: idle, nobody rung. */
export const NOBODY_DUE = "results['claim-followup']?.found != true";
/** The occurrence names the claimed person and the brand has a rep phone: ring. */
export const RING = "results['resolve-call']?.ok == true && results['resolve-call']?.hasRep == true";
/** The brand states no rep phone: nobody rung, the row is stopped. */
export const NO_REP = "results['resolve-call']?.ok == true && results['resolve-call']?.hasRep == false";
/** The run claimed someone its occurrence does not name: their row is left alone. */
export const OTHER_PERSON = "results['resolve-call']?.ok == false";

export function buildAiInstantCallDag(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false" },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run" } },
      { id: "plan-claim", type: "script", config: { code: PLAN_CLAIM_CODE }, retries: 0, inputMapping: { trigger: "$ref:flow_input.trigger" } },
      // THIS campaign's own queue: campaign-service made the occurrence's person due on it before the dispatch.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: { "params.campaignId": "$ref:flow_input.campaignId", skip: "$ref:plan-claim.output.skip" },
      },
      { id: "check-claim", type: "condition" },
      // Who they are. Best effort: a rep is rung about an unidentified buyer rather than not rung at all.
      {
        id: "lead-detail",
        type: "http.call",
        config: { service: "lead", method: "GET", path: "/orgs/leads/{id}", tolerateFailure: true },
        inputMapping: {
          "params.id": "$ref:claim-followup.output.followup.id",
          "query.campaignId": "$ref:flow_input.campaignId",
        },
      },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": PERSON_BRAND },
      },
      // The number to ring: the brand's stated sales rep.
      {
        id: "sales-rep",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/sales-rep" },
        inputMapping: { "params.brandId": PERSON_BRAND },
      },
      {
        id: "resolve-call",
        type: "script",
        config: { code: RESOLVE_CALL_CODE },
        retries: 0,
        inputMapping: {
          claim: "$ref:claim-followup.output",
          trigger: "$ref:flow_input.trigger",
          leadDetail: "$ref:lead-detail.output",
          rep: "$ref:sales-rep.output",
          brand: "$ref:brand-profile.output",
        },
      },
      // Converges (edge from claim-followup, outside check-claim's branch) so it is a top-level branchone.
      { id: "check-call", type: "condition" },
      // Apollo's reveal answers `pending` and delivers the number later: asked once, then waited for, bounded.
      // Skipped when the occurrence carries a phone or the person is not Apollo-sourced. A failure costs the
      // bridge, never the call.
      {
        id: "request-reveal",
        type: "http.call",
        config: { service: "apollo", method: "POST", path: "/people/{apolloPersonId}/phone-reveal", body: {}, tolerateFailure: true },
        retries: 0,
        inputMapping: {
          "params.apolloPersonId": "$ref:resolve-call.output.apolloPersonId",
          skip: "$ref:resolve-call.output.skipReveal",
        },
      },
      {
        id: "wait-reveal",
        type: "http.call",
        config: {
          service: "apollo",
          method: "GET",
          path: "/people/{apolloPersonId}/phone-reveal",
          tolerateFailure: true,
          pollWhile: {
            field: "status",
            equals: "pending",
            intervalSeconds: PHONE_REVEAL_POLL_SECONDS,
            timeoutSeconds: PHONE_REVEAL_WAIT_SECONDS,
          },
        },
        retries: 0,
        inputMapping: {
          "params.apolloPersonId": "$ref:resolve-call.output.apolloPersonId",
          skip: "$ref:resolve-call.output.skipReveal",
        },
      },
      {
        id: "build-call",
        type: "script",
        config: { code: BUILD_CALL_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:resolve-call.output",
          reveal: "$ref:wait-reveal.output",
          campaignId: "$ref:flow_input.campaignId",
          runId: "$ref:flow_input.runId",
        },
      },
      // Never retried: a call that may have rung is never placed a second time by this run.
      {
        id: "ring-rep",
        type: "http.call",
        config: { service: "twilio", method: "POST", path: "/calls" },
        retries: 0,
        inputMapping: { body: "$ref:build-call.output.body" },
      },
      // Strictly AFTER the call, and tolerated: nothing after a placed call may fail the run (a redelivery would ring again).
      stopRow("record-called", INSTANT_CALL_PLACED_REASON, true),
      stopRow("record-no-rep", NO_SALES_REP_PHONE_REASON),
      endRun("end-run", { success: true, stopCampaign: false }),
      endRun("end-run-no-rep", { success: true, stopCampaign: false }),
      endRun("end-run-other-person", { success: false, stopCampaign: false }),
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "plan-claim" },
      { from: "plan-claim", to: "claim-followup" },
      { from: "claim-followup", to: "check-claim" },
      { from: "check-claim", to: "lead-detail", condition: "results['claim-followup']?.found == true" },
      { from: "check-claim", to: "end-run-nobody-due", condition: NOBODY_DUE },
      { from: "lead-detail", to: "brand-profile" },
      { from: "brand-profile", to: "sales-rep" },
      { from: "sales-rep", to: "resolve-call" },
      { from: "resolve-call", to: "check-call" },
      { from: "claim-followup", to: "check-call" },
      { from: "check-call", to: "request-reveal", condition: RING },
      { from: "check-call", to: "record-no-rep", condition: NO_REP },
      { from: "check-call", to: "end-run-other-person", condition: OTHER_PERSON },
      { from: "request-reveal", to: "wait-reveal" },
      { from: "wait-reveal", to: "build-call" },
      { from: "build-call", to: "ring-rep" },
      { from: "ring-rep", to: "record-called" },
      { from: "record-called", to: "end-run" },
      { from: "record-no-rep", to: "end-run-no-rep" },
    ],
    onError: "end-run-error",
  };
}
