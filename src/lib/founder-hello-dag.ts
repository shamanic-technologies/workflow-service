/**
 * THE FOUNDER HELLO (FOUNDER-HELLO-1027, owner 2026-10-27: « avoir une campaign de bonjour du fondateur qui ne vise qu'à
 * ça »). A person who just set up the brand's product and gave their WhatsApp number gets ONE hello on WhatsApp from
 * the founder, showing he actually looked at what they set up. The outcome sought is their answer (a conversation).
 * Then nothing more from this campaign, ever.
 *
 * Its own channel and pipe (`founder-hello|start_to_conversation`, reactive on `whatsapp_number_given`), its own
 * WhatsApp template dynasty (the text in `founder-hello-template.ts`) and the leg's best LLM, both picked per run by
 * features-service (`withLegBestWhatsappTemplate`). Nothing here names a brand: any brand whose customers onboard on it
 * can run it.
 *
 * One run, one straight line (every node skip-gated by the plan before it), ONE condition at the end (`check-end`)
 * picking the end-run:
 *
 *  - Only a run whose trigger names a person claims (this campaign's own queue, `claim-person` on the claim). The row
 *    claimed must be that person, else it is left alone and the run fails (the occurrence is redelivered).
 *  - Once per person: a WhatsApp this campaign already sent them (crm-service's sends, read first) ends the run
 *    `already_greeted`; any WhatsApp message already in their thread (either way) ends it `already_talking`: someone
 *    of the brand already talks with them there, a hello would read as a bot. Our staff and the brand's own team are
 *    never greeted (crm-service `team-membership`). Each is `personNotAdmitted`, final.
 *  - The hello is written ONLY from what the person set up themselves: the onboarding record crm-service serves on
 *    their thread (`ONBOARDING_RECORD_STEP`), never the brand's own sales facts, never analytics event lines. No record
 *    on their thread = nothing written, the run fails loud (redelivered), never a hello that proves nothing.
 *  - The rhythm it copies is the founder's own hand-typed WhatsApp messages to the brand's BUSINESS contacts (crm-service
 *    tags them `professional_to_brand` and none `personal_*`), never a personal chat, a test, a staff alert or a
 *    message our software sent.
 *  - The sending account is crm-service's to pick; its persona (`reach.persona`) is who speaks.
 *  - Strictly after the send, the queue row is `stopped` (`FOUNDER_HELLO_SENT_REASON`). The send's idempotency key names
 *    the campaign and the PERSON, never the occurrence: a second number given by the same person is never a second hello.
 *  - `inputs.dryRun: true` (a staff replay): no chassis, no claim, the person is the trigger's; the admission is decided
 *    and REPORTED (`wouldNotAdmit`) but never blocks the writing; the message is written and recorded by
 *    content-generation exactly as a real one, nothing is sent, no row is touched.
 */
import type { DAG, DAGNode } from "./dag-validator.js";
import { GENERATE_WHATSAPP_PATH, withLegBestWhatsappTemplate } from "./whatsapp-template-writer.js";
import { CLAIM_PERSON_CODE } from "./claim-person.js";
import { CRM_WHATSAPP_SEND } from "./ai-meeting-booking-dag.js";
import { SENDER_PERSONA_FN } from "./sender-persona.js";
import { BUBBLE_SEND_FN, HAND_TYPED_FN } from "./whatsapp-bubbles.js";

export const FOUNDER_HELLO_FEATURE_SLUG = "founder-hello";
export const FOUNDER_HELLO_LEG_KEY = "start_to_conversation";
export const FOUNDER_HELLO_PIPE_ID = `${FOUNDER_HELLO_FEATURE_SLUG}|${FOUNDER_HELLO_LEG_KEY}`;
/** The fact that makes someone due: they typed their WhatsApp number while setting up the product. */
export const FOUNDER_HELLO_TRIGGER_ID = "whatsapp_number_given";

export const FOUNDER_HELLO_DESCRIPTION =
  "Sends one WhatsApp hello from the founder to a person who just set up the product and gave their number, naming what they set up themselves, then never writes again. It skips anyone already greeted, anyone already talking with the brand on WhatsApp, our staff and the brand's own team.";

/**
 * The timeline item crm-service serves the person's onboarding choices as (ONBOARDING-FICHE-1027): one event per account
 * (org x brand) they opened, `source: "onboarding"`, `event.step: "onboarding_record"`, the whole record in `text`
 * (plain lines, nothing cut). An unreadable owner = the `onboarding` source `failed`, never a partial record.
 */
export const ONBOARDING_RECORD_SOURCE = "onboarding";
export const ONBOARDING_RECORD_STEP = "onboarding_record";

/** How many of the founder's business conversations his rhythm is copied from. */
export const VOICE_SAMPLE_PEOPLE = 3;
/** A business contact counts as a sample once the founder wrote them at least this many WhatsApp messages. */
export const VOICE_SAMPLE_MIN_OUTBOUND = 3;
/** crm-service's connection tag for a person who is a lead, client or user of the brand. */
export const BUSINESS_CONTACT_TAG = "professional_to_brand";

/** Stored on the queue row once the hello went out: one hello per person, ever. */
export const FOUNDER_HELLO_SENT_REASON = "founder_hello_sent";

export const NOT_GREETED_CODES = {
  alreadyGreeted: "already_greeted",
  alreadyTalking: "already_talking",
  staff: "staff",
  ownTeam: "own_team",
} as const;

/** crm-service refusals the send (and its reach check) name: an outcome, never a failed run. */
export const FOUNDER_HELLO_REFUSAL_CODES = [
  "whatsapp_not_linked",
  "whatsapp_not_connected",
  "no_phone_known",
  "not_on_whatsapp",
  "person_replied",
  "automation_not_allowed",
  "human_in_conversation",
] as const;

const DRY = "flow_input.dryRun === true || flow_input.dryRun === 'true'";

/** Who to claim: nobody on a dry run (the trigger's person is used as is) or on a run whose trigger names nobody. */
export const PLAN_CLAIM_CODE = `
export async function main(claimPerson, dryRun) {
  const dry = dryRun === true || dryRun === "true";
  const named = claimPerson?.person ?? null;
  if (!dry && !named) console.log("[founder-hello] this run's trigger names nobody: nobody is claimed");
  return { dryRun: dry, skip: dry || !named };
}
`.trim();

/**
 * The person this run greets, or why nobody (`end`). Phone digits compare a person known only by phone.
 */
export const PICK_PERSON_CODE = `
export async function main(plan, claim, trigger, brandId) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const fold = (v) => (s(v) ? s(v).toLowerCase() : null);
  const digits = (v) => (s(v) && /^\\s*(\\+|00)/.test(v) ? v.replace(/^\\s*(\\+|00)/, "").replace(/\\D/g, "") : "");
  const t = trigger && typeof trigger === "object" ? trigger : {};
  const tp = t.person && typeof t.person === "object" ? t.person : {};
  const item = t.item && typeof t.item === "object" ? t.item : {};
  const nobody = (end) => ({ go: false, skip: true, end, sendsQuery: null, timelineQuery: null, peopleQuery: null, brandId: brandId ?? null });
  let row;
  if (plan?.dryRun === true) {
    if (!s(tp.email) && !s(tp.phone)) throw new Error("pick-person: a dry run names no person (inputs.trigger.person.email or .phone)");
    row = { id: null, leadId: s(t.leadId), email: s(tp.email), phone: s(tp.phone), brandId: brandId ?? null };
  } else {
    if (plan?.skip === true) return nobody("nobody_due");
    if (claim?.found !== true) return nobody("unclaimed");
    const f = claim.followup ?? {};
    if (!f.id || (!s(f.email) && !s(f.phone))) throw new Error("pick-person: a claimed row carries no id, or neither an email nor a phone");
    const sameEmail = s(f.email) && fold(f.email) === fold(tp.email);
    const samePhone = digits(f.phone).length >= 8 && digits(f.phone) === digits(tp.phone);
    if (!sameEmail && !samePhone) {
      console.error("[founder-hello] claimed " + String(f.email ?? f.phone) + " but this run's trigger names " + String(tp.email ?? tp.phone) + ": their row is left alone");
      return nobody("other_person");
    }
    row = { id: f.id, leadId: s(f.leadId), email: s(f.email), phone: s(tp.phone) ?? s(f.phone), brandId: s(f.brandId) ?? brandId ?? null };
  }
  if (!row.brandId) throw new Error("pick-person: no brand to greet this person for");
  const email = row.email ? row.email.toLowerCase() : null;
  const phoneDigits = digits(row.phone);
  const personKey = email ? "email:" + email : phoneDigits.length >= 8 ? "phone:+" + phoneDigits : null;
  if (!personKey) throw new Error("pick-person: the person carries neither an email nor a phone");
  const firstName = s(item.firstName) ?? (s(tp.name) ? s(tp.name).split(/\\s+/)[0] : null);
  return {
    go: true,
    skip: false,
    end: null,
    dryRun: plan?.dryRun === true,
    rowId: row.id,
    leadId: row.leadId,
    email,
    phone: phoneDigits.length >= 8 ? "+" + phoneDigits : null,
    brandId: row.brandId,
    firstName,
    sendsQuery: email ? { brandId: row.brandId, email } : { brandId: row.brandId, phone: "+" + phoneDigits },
    timelineQuery: { brandId: row.brandId, personKey },
    peopleQuery: { brandId: row.brandId, source: "matrix", limit: "60" },
  };
}
`.trim();

/**
 * Which of the brand's people the founder's rhythm is copied from: BUSINESS contacts only (crm-service tags them
 * \`professional_to_brand\` and no \`personal_*\` tag, and does not call them not-business), with enough WhatsApp messages
 * of his, never the person greeted. Each sample is then asked to crm-service's team check (our staff, the brand's own
 * team: a test thread to our own assistant's number is tagged business too) and dropped unless both answer no. Empty
 * slots are skipped reads.
 */
export const VOICE_PLAN_CODE = `
export async function main(person, people, verdict) {
  const empty = { skip: true, query: null, teamBody: null };
  if (person?.go !== true || verdict?.skip !== false) return { samples: Array.from({ length: ${VOICE_SAMPLE_PEOPLE} }, () => empty) };
  if (!Array.isArray(people?.people)) throw new Error("voice-plan: the brand's people index answered no people list");
  const isSelf = (p) => (person.email && (p.emails ?? []).map((e) => String(e).toLowerCase()).includes(person.email))
    || (person.phone && (p.phones ?? []).map((x) => String(x).replace(/\\D/g, "")).includes(person.phone.replace(/\\D/g, "")));
  const samples = [];
  for (const p of people.people) {
    if (samples.length >= ${VOICE_SAMPLE_PEOPLE}) break;
    if (!p?.personId || isSelf(p) || p.notBusiness === true || p.automated === true) continue;
    const tags = (Array.isArray(p.connectionTags) ? p.connectionTags : []).map((t) => String(t?.tag ?? ""));
    if (!tags.includes("${BUSINESS_CONTACT_TAG}") || tags.some((t) => t.startsWith("personal"))) continue;
    const wrote = (p.presences ?? []).filter((x) => x?.source === "matrix").reduce((n, x) => n + (Number(x.outboundCount) || 0), 0);
    if (wrote < ${VOICE_SAMPLE_MIN_OUTBOUND}) continue;
    const email = (p.emails ?? []).map((e) => String(e).trim()).find(Boolean);
    const phone = (p.phones ?? []).map((x) => String(x).trim()).find(Boolean);
    if (!email && !phone) continue;
    samples.push({
      skip: false,
      query: { brandId: person.brandId, personId: p.personId },
      teamBody: { brandId: person.brandId, ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
    });
  }
  while (samples.length < ${VOICE_SAMPLE_PEOPLE}) samples.push(empty);
  return { samples };
}
`.trim();

/**
 * Who may be greeted, off what is already on record, BEFORE anything is paid for. Once per person (this campaign's own
 * sends), never someone already talking with the brand on WhatsApp; then crm-service is asked whether they are our
 * staff or the brand's own team. A dry run asks nothing about the team (a staff replay greets nobody).
 */
export const ADMISSION_CODE = `
export async function main(person, sends, thread, campaignId) {
  if (person?.go !== true) return { go: false, skipTeam: true, teamBody: null, notAdmitted: null };
  const who = String(person.email ?? person.phone);
  const refuse = (code, reason) => {
    console.log("[founder-hello] " + who + " not greeted (" + code + "): " + reason);
    // A dry run (staff replay) states what a real run would decide and still writes: nothing is ever sent.
    if (person.dryRun === true) return { go: true, skipTeam: true, teamBody: null, code, notAdmitted: null, wouldNotAdmit: { reason: code + ": " + reason } };
    return { go: false, skipTeam: true, teamBody: null, code, notAdmitted: { reason: code + ": " + reason } };
  };
  if (!Array.isArray(sends?.sends)) throw new Error("admission: crm-service answered no sends list for " + who);
  const mine = sends.sends.find((x) => x?.campaignId === campaignId && ["sent", "sending"].includes(x?.status));
  if (mine) return refuse("${NOT_GREETED_CODES.alreadyGreeted}", "this campaign already said hello (" + String(mine.sentAt ?? mine.createdAt ?? "date unknown") + ")");
  if (!thread || !Array.isArray(thread.items)) throw new Error("admission: the person's thread did not come back");
  const failed = (thread.sources ?? []).filter((x) => x?.source === "matrix" && x?.status === "failed");
  if (failed.length) throw new Error("admission: the person's WhatsApp thread is unreadable (" + String(failed[0].error ?? "failed") + "); nobody is greeted blind");
  const chat = thread.items.find((i) => i?.kind === "message" && i?.source === "matrix");
  if (chat) return refuse("${NOT_GREETED_CODES.alreadyTalking}", "a WhatsApp message is already in their thread (" + String(chat.direction) + ", " + String(chat.at ?? "date unknown") + ")");
  if (person.dryRun === true) return { go: true, skipTeam: true, teamBody: null, notAdmitted: null };
  return {
    go: true,
    skipTeam: false,
    teamBody: { brandId: person.brandId, ...(person.email ? { email: person.email } : {}), ...(person.phone ? { phone: person.phone } : {}) },
    notAdmitted: null,
  };
}
`.trim();

/**
 * The hello goes from the brand's FOUNDER line (crm-service \`fromLine\`, SOPHIE-SENDS-1028; owner 2026-10-28: every other
 * campaign writes from the assistant line, the hello from the founder's own). A brand stating no founder line is
 * refused \`whatsapp_not_linked\`: nothing sent.
 */
export const FOUNDER_LINE = "founder";

/** Our staff and the brand's own team are never greeted; then the reach check names exactly the send. */
export const REACH_PLAN_CODE = `
export async function main(person, admission, team) {
  if (admission?.go !== true) return { skip: true, notAdmitted: admission?.notAdmitted ?? null, code: admission?.code ?? null };
  if (admission.skipTeam !== true) {
    if (!team || team.notCalled === true || typeof team.staff !== "boolean" || typeof team.ownTeam !== "boolean") {
      throw new Error("reach-plan: crm-service did not say whether this person is our staff or the brand's own team; nobody is greeted blind");
    }
    const via = (Array.isArray(team.matches) ? team.matches : []).map((m) => String(m?.description ?? m?.kind)).join(", ");
    if (team.staff === true) return { skip: true, code: "${NOT_GREETED_CODES.staff}", notAdmitted: { reason: "${NOT_GREETED_CODES.staff}: one of our own staff (" + via + ")" } };
    if (team.ownTeam === true) return { skip: true, code: "${NOT_GREETED_CODES.ownTeam}", notAdmitted: { reason: "${NOT_GREETED_CODES.ownTeam}: one of the brand's own team (" + via + ")" } };
  }
  return {
    skip: false,
    notAdmitted: null,
    code: null,
    reachBody: { brandId: person.brandId, fromLine: "${FOUNDER_LINE}", skipIfReplied: person.dryRun !== true, ...(person.email ? { email: person.email } : {}), ...(person.phone ? { phone: person.phone } : {}) },
  };
}
`.trim();

/** crm-service's reach answer merged in: reachable = the persona of the account that sends; else its refusal, nothing drafted. */
export const REACH_VERDICT_CODE = `
export async function main(plan, check, person) {
  if (plan?.skip === true) return { ...plan, refused: null };
  if (!check || check.notCalled === true || typeof check.reachable !== "boolean") {
    throw new Error("reach-verdict: crm-service's reach check gave no answer; nothing is drafted blind");
  }
  if (check.reachable === true) return { skip: false, refused: null, persona: senderPersona(check), assistantLine: assistantLineOf(check) };
  const code = typeof check.code === "string" && check.code ? check.code : "not_reachable";
  const reason = typeof check.error === "string" && check.error.trim() ? check.error : "This person cannot be reached on WhatsApp: nothing was sent.";
  console.error("[founder-hello] crm-service says WhatsApp cannot reach this person (" + code + "): nothing drafted, nothing sent");
  // A dry run (staff replay) reports the refusal and still writes, as the account that would send.
  if (person?.dryRun === true) return { skip: false, refused: null, wouldRefuse: { code, reason }, persona: senderPersona(check), assistantLine: null };
  return { skip: true, refused: { code, reason } };
}

/** The brand's assistant line (crm-service \`assistantLine\`): who the person can run everything through, or null. */
function assistantLineOf(check) {
  const a = check?.assistantLine;
  if (!a || typeof a.phone !== "string" || !a.phone.trim()) return null;
  const name = typeof a.persona?.name === "string" && a.persona.name.trim() ? a.persona.name.trim() : null;
  const role = typeof a.persona?.role === "string" && a.persona.role.trim() ? a.persona.role.trim() : null;
  return { phone: a.phone.trim(), name, role };
}

${SENDER_PERSONA_FN}
`.trim();

/**
 * The writer's variables and its context. WHAT THEY SET UP is crm-service's onboarding record on the person's thread,
 * verbatim: the only facts the hello may use. The thread shows the messages they already got from us (labelled), so
 * nothing is repeated. The voice is the sending persona plus the founder's own typed messages to business contacts.
 */
export const COMPOSE_CODE = `
export async function main(person, verdict, thread, brand, rep, currentDate, v1, v2, v3, t1, t2, t3) {
  if (verdict?.skip !== false) return { skip: true, variables: null, message: null };
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose: the brand read carries no name");
  const persona = senderPersona(verdict);
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const founderName = persona ? persona.name : s(rep?.salesRepFirstName);
  if (!founderName) throw new Error("compose: neither the sending account's persona nor the brand's sales rep names who says hello");
  if (!thread || !Array.isArray(thread.items)) throw new Error("compose: the person's thread did not come back");

  const recordSource = (thread.sources ?? []).find((x) => x?.source === "${ONBOARDING_RECORD_SOURCE}");
  if (recordSource?.status === "failed") {
    throw new Error("compose: crm-service could not read what " + String(person?.email ?? person?.phone) + " set up (" + String(recordSource.error ?? "failed") + "); nothing is written blind");
  }
  const records = thread.items.filter((i) => i?.source === "${ONBOARDING_RECORD_SOURCE}" && i?.event?.step === "${ONBOARDING_RECORD_STEP}" && s(i.text));
  if (!records.length) {
    throw new Error("compose: no onboarding record on " + String(person?.email ?? person?.phone) + "'s thread (crm-service); a hello that cannot name what they set up is never written");
  }
  // One record per account they opened, verbatim.
  const setup = records.flatMap((r, k) => [...(k > 0 ? [""] : []), ...String(r.text).split(/\\r?\\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "")]);

  const clip = (t, n) => { const x = String(t ?? "").replace(/\\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "..." : x; };
  const label = (i) => {
    if (i.direction === "inbound") return "THEM";
    if (i.source === "copilot") return "US [AI Copilot]";
    if (i.sentBy === "automation" || i.source === "transactional" || i.source === "instantly") return "US [automated " + String(i.channel ?? "message") + "]";
    return "US";
  };
  const messages = thread.items.filter((i) => i?.kind === "message" && i.source !== "api" && s(i.text));
  const threadLines = messages.slice(-12).map((i) => String(i.at ?? "").slice(0, 16).replace("T", " ") + " | " + String(i.channel) + " | " + label(i) + ": " + clip(i.text, 400));

  const voice = [];
  // A sample counts only when crm-service said it is neither our staff nor the brand's own team (a test is not a client).
  const outsider = (t) => t && t.notCalled !== true && t.staff === false && t.ownTeam === false;
  // An attachment shows as its file name: never a typed line.
  const attachment = (t) => String(t).trim().length <= 80 && /\\.(ogg|opus|mp3|m4a|jpe?g|png|gif|webp|pdf|mp4|mov|docx?|xlsx?)$/i.test(String(t).trim());
  for (const [v, t] of [[v1, t1], [v2, t2], [v3, t3]]) {
    if (!Array.isArray(v?.items) || !outsider(t)) continue;
    // Typed by a person of the brand (crm-service \`sentBy\`), never one of our automated sends.
    const outbound = v.items.filter((i) => i?.kind === "message" && i?.direction === "outbound" && i?.source === "matrix" && i?.sentBy === "person" && s(i.text) && !attachment(i.text));
    for (const i of handTyped(outbound).slice(-10)) voice.push("- " + clip(i.text, 300));
  }

  const variables = {
    founderName,
    brandName,
    writerRole: "You are " + founderName + (persona?.role ? ", " + persona.role : ", founder") + " of " + brandName + ". You write ONE WhatsApp message to one person, from " + brandName + "'s WhatsApp number, as yourself.",
    voiceRules: [
      ...(persona ? personaLines(persona, brandName) : []),
      voice.length
        ? "HOW " + founderName.toUpperCase() + " TEXTS: copy the rhythm of HIS OWN MESSAGES to " + brandName + "'s clients and leads below (how many bubbles, how long, how he opens, his punctuation and capitals), never their content."
        : "HOW " + founderName.toUpperCase() + " TEXTS: short and plain, the way a founder texts a new customer from his phone.",
    ].join("\\n"),
  };
  const firstName = s(person?.firstName);
  const message = [
    "TODAY: " + String(currentDate ?? new Date().toISOString().slice(0, 10)),
    "",
    "WHO WE WRITE TO: " + (firstName ? "first name " + firstName : "first name unknown: no name in the hello"),
    "",
    "WHAT THEY SET UP WITH " + brandName.toUpperCase() + " (their own choices, the only facts you may use):",
    ...setup,
    "",
    "THE ASSISTANT LINE: " + (verdict.assistantLine
      ? (verdict.assistantLine.name ?? "our assistant") + (verdict.assistantLine.role ? ", " + verdict.assistantLine.role : "") + ", writes to them from " + verdict.assistantLine.phone
      : "none"),
    "",
    "THE MESSAGES THEY ALREADY GOT FROM US (never repeat them):",
    ...(threadLines.length ? threadLines : ["(none)"]),
    ...(voice.length ? ["", "HIS OWN MESSAGES TO " + brandName.toUpperCase() + "'S CLIENTS AND LEADS (rhythm only):", ...voice] : []),
  ].join("\\n");
  return { skip: false, variables, message };
}

${HAND_TYPED_FN}

${SENDER_PERSONA_FN}
`.trim();

/** The written bubbles as crm-service's send body, keyed on the campaign and the PERSON: one hello per person, ever. */
export const FINALIZE_CODE = `
export async function main(compose, draft, person, campaignId) {
  if (compose?.skip !== false) return { skipSend: true, written: false, sendBody: null };
  const json = draft?.json ?? draft ?? {};
  if (json.decision !== "write") throw new Error("finalize: the writer answered " + JSON.stringify(json.decision) + "; a hello is always written now");
  const text = String(json.message ?? "")
    .replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-")
    .replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ")
    .trim();
  if (!text) throw new Error("finalize: the writer returned an empty message");
  const who = person.leadId ?? person.email ?? person.phone;
  const idempotencyKey = "founder-hello:" + String(campaignId) + ":" + String(who);
  if (person.dryRun === true) {
    console.log("[founder-hello] DRY RUN, nothing sent to " + String(person.email ?? person.phone) + ":\\n" + text);
    return { skipSend: true, written: true, dryRun: true, text, idempotencyKey, sendBody: null };
  }
  return {
    skipSend: false,
    written: true,
    text,
    idempotencyKey,
    // Never a null field (crm-service 400s it). skipIfReplied: they wrote to the brand meanwhile = no hello.
    sendBody: { ...(person.email ? { email: person.email } : {}), brandId: person.brandId, fromLine: "${FOUNDER_LINE}", ...bubbleSendFields(text), idempotencyKey, skipIfReplied: true, ...(person.phone ? { phone: person.phone } : {}) },
  };
}

${BUBBLE_SEND_FN}
`.trim();

/** How the run ends, and what is stated on the queue row. */
export const OUTCOME_CODE = `
export async function main(person, reach, verdict, final, send, admission) {
  const row = (reason) => ({ skipRecord: !person?.rowId, rowId: person?.rowId ?? null, rowReason: reason });
  if (person?.go !== true) return { endKind: person?.end ?? "nobody_due", skipRecord: true, rowId: null, rowReason: null };
  if (person.dryRun === true) return { endKind: "dry_run", skipRecord: true, rowId: null, rowReason: null, text: final?.text ?? null, wouldNotAdmit: admission?.wouldNotAdmit ?? reach?.notAdmitted ?? null, refused: verdict?.wouldRefuse ?? null };
  if (reach?.notAdmitted) return { endKind: "not_admitted", notAdmitted: reach.notAdmitted, ...row("founder_hello_" + String(reach.code)) };
  if (verdict?.refused) return { endKind: "refused", delivery: { state: "refused", code: verdict.refused.code, reason: verdict.refused.reason }, ...row("founder_hello_whatsapp_" + verdict.refused.code) };
  if (send?.skipped === true && send?.notCalled !== true) {
    const code = typeof send.code === "string" && send.code ? send.code : "refused";
    const reason = typeof send.refusal?.error === "string" ? send.refusal.error : "WhatsApp refused the hello: nothing was sent.";
    return { endKind: "refused", delivery: { state: "refused", code, reason }, ...row("founder_hello_whatsapp_" + code) };
  }
  if (final?.written === true && send && send.notCalled !== true) return { endKind: "sent", delivery: { state: "delivered" }, ...row("${FOUNDER_HELLO_SENT_REASON}") };
  throw new Error("outcome: the run reached its end with no hello sent and no reason named");
}
`.trim();

const crmRead = (id: string, path: string, query: string, skip: string, tolerate = false): DAGNode => ({
  id,
  type: "http.call",
  config: { service: "crm", method: "GET", path, ...(tolerate ? { tolerateFailure: true } : {}) },
  retries: 1,
  inputMapping: { query, skip },
});

const endRun = (id: string, body: Record<string, unknown>, inputMapping?: Record<string, string>): DAGNode => ({
  id,
  type: "http.call",
  config: { service: "campaign", method: "POST", path: "/end-run", body, skipIf: DRY },
  ...(inputMapping ? { inputMapping } : {}),
});

const END = (kind: string) => `results['outcome']?.endKind == '${kind}'`;
export const FOUNDER_HELLO_ENDS = ["sent", "refused", "not_admitted", "nobody_due", "unclaimed", "other_person", "dry_run"] as const;

function founderHelloDagUnvoiced(): DAG {
  return {
    nodes: [
      {
        id: "gate-check",
        type: "http.call",
        config: { service: "campaign", method: "POST", path: "/gate-check", stopAfterIf: "result.allowed == false", skipIf: DRY },
      },
      { id: "start-run", type: "http.call", config: { service: "campaign", method: "POST", path: "/start-run", skipIf: DRY } },
      { id: "claim-person", type: "script", config: { code: CLAIM_PERSON_CODE }, retries: 0, inputMapping: { trigger: "$ref:flow_input.trigger" } },
      {
        id: "plan-claim",
        type: "script",
        config: { code: PLAN_CLAIM_CODE },
        retries: 0,
        inputMapping: { claimPerson: "$ref:claim-person.output", dryRun: "$ref:flow_input.dryRun" },
      },
      // THIS campaign's own queue: campaign-service made the person due on it right before the dispatch.
      {
        id: "claim-followup",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next" },
        retries: 0,
        inputMapping: {
          "params.campaignId": "$ref:flow_input.campaignId",
          "body.person": "$ref:claim-person.output.person",
          skip: "$ref:plan-claim.output.skip",
        },
      },
      {
        id: "pick-person",
        type: "script",
        config: { code: PICK_PERSON_CODE },
        retries: 0,
        inputMapping: {
          plan: "$ref:plan-claim.output",
          claim: "$ref:claim-followup.output",
          trigger: "$ref:flow_input.trigger",
          brandId: "$ref:flow_input.brandId",
        },
      },
      crmRead("prior-sends", "/orgs/whatsapp/messages", "$ref:pick-person.output.sendsQuery", "$ref:pick-person.output.skip"),
      crmRead("person-thread", "/orgs/people/timeline", "$ref:pick-person.output.timelineQuery", "$ref:pick-person.output.skip"),
      {
        id: "admission",
        type: "script",
        config: { code: ADMISSION_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          sends: "$ref:prior-sends.output",
          thread: "$ref:person-thread.output",
          campaignId: "$ref:flow_input.campaignId",
        },
      },
      {
        id: "team-membership",
        type: "http.call",
        config: { service: "crm", method: "POST", path: "/orgs/people/team-membership" },
        retries: 1,
        inputMapping: { body: "$ref:admission.output.teamBody", skip: "$ref:admission.output.skipTeam" },
      },
      {
        id: "reach-plan",
        type: "script",
        config: { code: REACH_PLAN_CODE },
        retries: 0,
        inputMapping: { person: "$ref:pick-person.output", admission: "$ref:admission.output", team: "$ref:team-membership.output" },
      },
      {
        id: "reach-check",
        type: "http.call",
        config: { service: "crm", method: "POST", path: "/orgs/whatsapp/reach" },
        retries: 1,
        inputMapping: { body: "$ref:reach-plan.output.reachBody", skip: "$ref:reach-plan.output.skip" },
      },
      {
        id: "reach-verdict",
        type: "script",
        config: { code: REACH_VERDICT_CODE },
        retries: 0,
        inputMapping: { plan: "$ref:reach-plan.output", check: "$ref:reach-check.output", person: "$ref:pick-person.output" },
      },
      {
        id: "brand-profile",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/internal/brands/{id}" },
        inputMapping: { "params.id": "$ref:pick-person.output.brandId", skip: "$ref:reach-verdict.output.skip" },
      },
      {
        id: "sales-rep",
        type: "http.call",
        config: { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/sales-rep" },
        inputMapping: { "params.brandId": "$ref:pick-person.output.brandId", skip: "$ref:reach-verdict.output.skip" },
      },
      crmRead("voice-people", "/orgs/people", "$ref:pick-person.output.peopleQuery", "$ref:reach-verdict.output.skip"),
      {
        id: "voice-plan",
        type: "script",
        config: { code: VOICE_PLAN_CODE },
        retries: 0,
        inputMapping: { person: "$ref:pick-person.output", people: "$ref:voice-people.output", verdict: "$ref:reach-verdict.output" },
      },
      ...Array.from({ length: VOICE_SAMPLE_PEOPLE }, (_, i) => [
        crmRead(`voice-thread-${i + 1}`, "/orgs/people/timeline", `$ref:voice-plan.output.samples.${i}.query`, `$ref:voice-plan.output.samples.${i}.skip`, true),
        {
          id: `voice-team-${i + 1}`,
          type: "http.call" as const,
          // A sample nobody could check is dropped (compose), never the run failed for it.
          config: { service: "crm", method: "POST", path: "/orgs/people/team-membership", tolerateFailure: true },
          retries: 1,
          inputMapping: { body: `$ref:voice-plan.output.samples.${i}.teamBody`, skip: `$ref:voice-plan.output.samples.${i}.skip` },
        },
      ]).flat(),
      {
        id: "compose",
        type: "script",
        config: { code: COMPOSE_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          verdict: "$ref:reach-verdict.output",
          thread: "$ref:person-thread.output",
          brand: "$ref:brand-profile.output",
          rep: "$ref:sales-rep.output",
          currentDate: "$ref:flow_input.currentDate",
          v1: "$ref:voice-thread-1.output",
          v2: "$ref:voice-thread-2.output",
          v3: "$ref:voice-thread-3.output",
          t1: "$ref:voice-team-1.output",
          t2: "$ref:voice-team-2.output",
          t3: "$ref:voice-team-3.output",
        },
      },
      {
        id: "draft-message",
        type: "http.call",
        config: { service: "content-generation", method: "POST", path: GENERATE_WHATSAPP_PATH, body: { featureSlug: FOUNDER_HELLO_FEATURE_SLUG } },
        retries: 0,
        inputMapping: {
          "body.context": "$ref:compose.output.message",
          "body.variables": "$ref:compose.output.variables",
          "body.workflowSlug": "$ref:flow_input.workflowSlug",
          "body.campaignId": "$ref:flow_input.campaignId",
          "body.leadId": "$ref:pick-person.output.leadId",
          skip: "$ref:compose.output.skip",
        },
      },
      {
        id: "finalize",
        type: "script",
        config: { code: FINALIZE_CODE },
        retries: 0,
        inputMapping: {
          compose: "$ref:compose.output",
          draft: "$ref:draft-message.output",
          person: "$ref:pick-person.output",
          campaignId: "$ref:flow_input.campaignId",
        },
      },
      {
        id: "send-whatsapp",
        type: "http.call",
        config: { ...CRM_WHATSAPP_SEND, skipOnRefusalCodes: [...FOUNDER_HELLO_REFUSAL_CODES] },
        retries: 0,
        inputMapping: { body: "$ref:finalize.output.sendBody", skip: "$ref:finalize.output.skipSend" },
      },
      {
        id: "outcome",
        type: "script",
        config: { code: OUTCOME_CODE },
        retries: 0,
        inputMapping: {
          person: "$ref:pick-person.output",
          reach: "$ref:reach-plan.output",
          verdict: "$ref:reach-verdict.output",
          final: "$ref:finalize.output",
          send: "$ref:send-whatsapp.output",
          admission: "$ref:admission.output",
        },
      },
      // Strictly AFTER the send: the row is closed for good, one hello per person.
      {
        id: "record-row",
        type: "http.call",
        config: { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", body: { kind: "stopped" } },
        retries: 1,
        inputMapping: {
          "params.id": "$ref:outcome.output.rowId",
          "body.reason": "$ref:outcome.output.rowReason",
          skip: "$ref:outcome.output.skipRecord",
        },
      },
      { id: "check-end", type: "condition" },
      endRun("end-run-sent", { success: true, stopCampaign: false }, { "body.delivery": "$ref:outcome.output.delivery" }),
      endRun("end-run-refused", { success: true, stopCampaign: false }, { "body.delivery": "$ref:outcome.output.delivery" }),
      endRun("end-run-not-admitted", { success: true, stopCampaign: false }, { "body.personNotAdmitted": "$ref:outcome.output.notAdmitted" }),
      endRun("end-run-nobody-due", { success: true, stopCampaign: false, noWorkAvailable: true }),
      endRun("end-run-unclaimed", { success: false, stopCampaign: false }),
      endRun("end-run-other-person", { success: false, stopCampaign: false }),
      { id: "dry-summary", type: "script", config: { code: DRY_SUMMARY_CODE }, retries: 0, inputMapping: { outcome: "$ref:outcome.output" } },
      endRun("end-run-error", { success: false, stopCampaign: false }),
    ],
    edges: [
      { from: "gate-check", to: "start-run" },
      { from: "start-run", to: "claim-person" },
      { from: "claim-person", to: "plan-claim" },
      { from: "plan-claim", to: "claim-followup" },
      { from: "claim-followup", to: "pick-person" },
      { from: "pick-person", to: "prior-sends" },
      { from: "prior-sends", to: "person-thread" },
      { from: "person-thread", to: "admission" },
      { from: "admission", to: "team-membership" },
      { from: "team-membership", to: "reach-plan" },
      { from: "reach-plan", to: "reach-check" },
      { from: "reach-check", to: "reach-verdict" },
      { from: "reach-verdict", to: "brand-profile" },
      { from: "brand-profile", to: "sales-rep" },
      { from: "sales-rep", to: "voice-people" },
      { from: "voice-people", to: "voice-plan" },
      { from: "voice-plan", to: "voice-thread-1" },
      ...Array.from({ length: VOICE_SAMPLE_PEOPLE }, (_, i) => [
        { from: `voice-thread-${i + 1}`, to: `voice-team-${i + 1}` },
        { from: `voice-team-${i + 1}`, to: i + 1 < VOICE_SAMPLE_PEOPLE ? `voice-thread-${i + 2}` : "compose" },
      ]).flat(),
      { from: "compose", to: "draft-message" },
      { from: "draft-message", to: "finalize" },
      { from: "finalize", to: "send-whatsapp" },
      { from: "send-whatsapp", to: "outcome" },
      { from: "outcome", to: "record-row" },
      { from: "record-row", to: "check-end" },
      { from: "check-end", to: "end-run-sent", condition: END("sent") },
      { from: "check-end", to: "end-run-refused", condition: END("refused") },
      { from: "check-end", to: "end-run-not-admitted", condition: END("not_admitted") },
      { from: "check-end", to: "end-run-nobody-due", condition: END("nobody_due") },
      { from: "check-end", to: "end-run-unclaimed", condition: END("unclaimed") },
      { from: "check-end", to: "end-run-other-person", condition: END("other_person") },
      { from: "check-end", to: "dry-summary", condition: END("dry_run") },
    ],
    onError: "end-run-error",
  };
}

export const DRY_SUMMARY_CODE = `
export async function main(outcome) {
  return { dryRun: true, text: outcome?.text ?? null, wouldNotAdmit: outcome?.wouldNotAdmit ?? null, refused: outcome?.refused ?? null };
}
`.trim();

export function buildFounderHelloDag(): DAG {
  return withLegBestWhatsappTemplate(founderHelloDagUnvoiced(), "draft-message");
}
