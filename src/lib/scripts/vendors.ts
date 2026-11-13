/**
 * FACTORY-P2-ENGINES: the vendors a stored script may call, each one of OUR metered doors, called with the RUN's
 * identity (the script's own runs-service run as `x-run-id`, the caller's org, user, brand and campaign), so every
 * dollar a script spends lands on its run and is declared by the service that spent it (chat-service declares an
 * LLM call's cost itself). A closed list: a name not here answers `{ok: false}` naming it, and a new vendor is one
 * more entry (treg next), never a raw `fetch` handed to a script.
 *
 * A vendor answers `{ok, data}` like the GTM Factory vendor client: a refusal is an answer the script reads, never a
 * thrown error (the script decides; `throw` in its own code fails the run loudly).
 */
import type { VendorAnswer } from "./replay.js";
import { longRequest } from "./long-request.js";

export interface VendorDeps {
  /** chat-service `POST /complete` on the run (its own key + the given headers). */
  complete(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /** chat-service `POST /orgs/judgments` (Jev) on the run. */
  judge(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /** chat-service `GET /internal/skills/{slug}` (our voice, read live). */
  readSkill(slug: string): Promise<{ content?: unknown; version?: unknown } | null>;
  /**
   * chat-service `POST /internal/platform-complete`: the same completion, PLATFORM-billed, its platform run a child of
   * the script's run (`x-run-id`). Only for a run whose caller has no org request behind it (a service's own sweep,
   * `POST /internal/scripts/run`), exactly as that service's own code called it.
   */
  platformComplete(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /** chat-service `POST /internal/platform-judgments` (Jev, platform-billed) on the script's run. */
  platformJudge(body: Record<string, unknown>, headers: Record<string, string>): Promise<Record<string, unknown>>;
  /**
   * A SERVICE DOOR (FACTORY-P3 service switches): one call of the owning service's own code for the work it has in
   * flight for the caller's run (`x-caller-run-id`), on the script's run (`x-run-id`), with its own billing, rows and
   * declarations. `service` names `<SERVICE>_SERVICE_URL` / `_API_KEY`. Answers `{status, body}`: 200 = its answer.
   */
  serviceDoor(service: string, method: "GET" | "POST" | "PUT", path: string, body: Record<string, unknown> | null, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }>;
  /**
   * The open times of a PUBLIC booking page (GoHighLevel, Calendly, Google: free, no credential), spread across the next
   * days in the person's timezone: `{bookingUrl, timezone, slots, calendarId?, degraded?, degradedReason?}`.
   */
  readBookingSlots?(bookingUrl: string, timezone: string): Promise<Record<string, unknown>>;
  /** Waits between two asks of a run door's bounded poll (a vendor wait, never the script's compute). */
  sleep?(ms: number): Promise<void>;
}

export interface VendorCallContext {
  /** Downstream headers of the script's run (x-run-id = the script's own run). */
  headers: Record<string, string>;
  /** The script's tactics (its own, then the run's on top). */
  tactics: Record<string, unknown>;
  /**
   * A completion's exact request and chat-service's WHOLE answer, handed to the run's trace (a step run with
   * `trace: true`): the service that records the Unit stores them (the fleet writer: content-generation's row).
   */
  onCompletion?: (exchange: { sent: Record<string, unknown>; raw: Record<string, unknown> }) => void;
  /**
   * Who pays the vendor (the caller's choice, never the script's): `org` (default, the run's org through `/complete`)
   * or `platform` (a service's own sweep with no org request: chat-service's platform doors, x-run-id = the run).
   */
  billing?: "org" | "platform";
  /** The run that asked for the script (its parent): a service's door serves only the work it has in flight for it. */
  callerRunId?: string;
  /** The outcome of the script's Engine (a door with `outcomeInBody` declares the Unit under it). */
  outcome?: string;
}

/** The headers of a platform call: only whose work it is (the script's run), as chat-service's platform doors read. */
function platformHeaders(headers: Record<string, string>): Record<string, string> {
  const runId = headers["x-run-id"];
  // PLATFORM-CALLER-RUN-1024: a platform call always states whose work it is; here, always the script's own run.
  if (!runId) throw new Error("a platform-billed vendor call needs the script's run (x-run-id)");
  return { "x-run-id": runId };
}

/** An LLM completion, answered with chat-service's whole answer `{content, json, model, tokensInput, tokensOutput}`. */
export const LLM_COMPLETE = "llm.complete";
/** The same completion, answered with the model's parsed JSON object itself. */
export const CHAT_COMPLETE = "chat.complete";
/** Jev yes/no judgments: `{state, questions: {<key>: {instructions, whenTrue?, whenFalse?}}}` -> `{probabilities: {<key>: P(yes)}, model}`. */
export const JEV_NOUL = "jev.noul";
/**
 * Jev choice judgments (MIGRATE-1105 S2b, the orphan-reply judgment): `{state?, questions: {<key>: {type: "choice",
 * instructions, criteria: {<option>: string | {what, examples?}}}}}` sent to chat-service exactly as stated (the body the
 * service's own code sent) -> `{answers: {<key>: {choice, confidence, probabilities}}, model, usage}` as chat answered.
 */
export const JEV_CHOICE = "jev.choice";
/** Our one voice (chat-service skill `client-comms`), for a writer that builds its own system prompt: `{content, version}`. */
export const VOICE_READ = "voice.read";
/**
 * The LLM of ONE call, read off the script's own TACTICS (SCRIPT-VALUE-RATING-1113-WF2, owner 2026-11-13: « un pick =
 * toujours un script », « le LLM et le template sont des tactics du script »): `{place, outcome?}` -> tactic
 * `llms[place]` else `llm` (`{provider, model}`), answered `{provider, model, llmDynastySlug, name, place, outcome, llm}`.
 * No run-time pick: another LLM is another dynasty, compared by features-service's script pick. None stated = a refusal.
 */
export const LLM_PICK = "llm.pick";
/**
 * The TEMPLATE of one writing call, read off the script's own tactics (SCRIPT-VALUE-RATING-1113-WF2): `{place, outcome?}`
 * -> tactic `templates[place]` else `template` (a template dynasty slug), answered `{templateDynastySlug, name, head,
 * place, outcome, template}`. None stated = a refusal the script throws on: nothing written, never a fixed template.
 */
export const TEMPLATE_PICK = "template.pick";
/** The open times of the offer's public booking page (`{bookingUrl, timezone}` -> `{slots, calendarId?, ...}`). */
export const BOOKING_SLOTS = "booking.slots";
/**
 * The service doors a stored script may call (FACTORY-P3 service switches), each the owning service's own code for
 * the work it has in flight: `args` = the call's fields (all required, sent as the body, or the query on a GET);
 * `okFrom` = a GET whose answer is a yes/no (`ok` = that field is true, nothing else answered).
 */
export type ServiceDoor =
  | { service: string; method: "GET" | "POST"; path: string; args: string[]; optional?: string[]; okFrom?: string; asRun?: undefined }
  /**
   * A RUN door (MIGRATE-1105 S1): one of the owning service's own org routes, called AS the script's run (its org,
   * user, brand, campaign; `x-run-id` = the script's run), so the producer bills, files and declares exactly as when a
   * workflow step called it. The call is stated like that step's request: `{params?, query?, body?, omitHeaders?,
   * pollWhile?}`; the answer is the producer's whole one: ok on 2xx (`data` = its body), else ok false with
   * `{error, status, code, body}` so a script reads a named refusal (a 409 `human_took_over`) and decides.
   * `runIdInBody`: the producer reads the run it files under from a BODY field (twilio's `parentRunId`), not from the
   * header: the door fills that field with the script's run (a script never knows its run id), and a recorded request
   * is compared without it (windmill-cases.ts).
   * `outcomeInBody` (MIGRATE-1105 S5): the producer declares the Unit on the script's behalf and reads WHICH outcome
   * from a BODY field (meta-service's `outcomeKey`): the door fills it with the outcome of the script's Engine, so a
   * script re-homed onto its fine outcome (Threads post published) has its Units declared under it, and a script never
   * names its own outcome.
   */
  | { service: string; method: "GET" | "POST" | "PUT"; path: string; asRun: true; runIdInBody?: string; outcomeInBody?: string };

export const SERVICE_DOOR_VENDORS: Record<string, ServiceDoor> = {
  // email_found (apollo-service): one verifier call -> {verificationId, verifier, verdict, error}; BounceVerify asked now.
  "apollo.email.verify": { service: "apollo", method: "POST", path: "/internal/email-verifier-calls", args: ["verifier", "email"] },
  "apollo.apify.available": { service: "apollo", method: "GET", path: "/internal/email-verifier-calls/apify", args: ["email"], okFrom: "available" },
  // lead_identified (lead-service): one candidate's screen, must-pass checks, reveal, decline.
  "lead.candidate.screen": { service: "lead", method: "POST", path: "/internal/candidate-decisions/screen", args: ["candidateId"] },
  "lead.candidate.must_pass": { service: "lead", method: "POST", path: "/internal/candidate-decisions/must-pass", args: ["candidateId"] },
  "lead.candidate.reveal": { service: "lead", method: "POST", path: "/internal/candidate-decisions/reveal", args: ["candidateId"] },
  "lead.candidate.decline": { service: "lead", method: "POST", path: "/internal/candidate-decisions/decline", args: ["candidateId", "reason"] },
  // lead_found (human-service): a PAGE of teasers with the facts each free rule reads, then the page's verdicts
  // (one run per walk, never per person: a walk stays far under the 500 host calls).
  "human.walk.page": { service: "human", method: "POST", path: "/internal/candidate-walks/page", args: ["walk", "limit"] },
  "human.walk.decide": { service: "human", method: "POST", path: "/internal/candidate-walks/decide", args: ["walk", "verdicts"] },
  // audience_built (human-service): the split's completion and its icon judgment, human-service's exact chat calls.
  "human.split.complete": { service: "human", method: "POST", path: "/internal/audience-splits/complete", args: ["proposal", "message", "systemPrompt"], optional: ["provider", "model", "responseSchema", "disableThinking"] },
  "human.split.judge": { service: "human", method: "POST", path: "/internal/audience-splits/judge", args: ["proposal", "state", "questions"] },
  // lead_found (lead-service, MIGRATE-1105 S0): one serve for the campaign the script's run is for (its headers name the
  // campaign, brand and audience): lead-service finds, files, buys and declares the person, or names why nobody came.
  "lead.serve": {
    service: "lead",
    method: "POST",
    path: "/orgs/buffer/next",
    args: [],
    optional: ["acceptedEmails", "reachableBy", "reachableOn", "relationships", "stepFilter", "excludeEmailedWithin", "population", "namedLead", "dueFollowupOnly"],
  },
  // Answering a lead (MIGRATE-1105 S1): what the old answering steps called, each the producer's own org route.
  // The person's whole thread, their state, the brand's facts and booking, then one act: reply, WhatsApp, book, call.
  "crm.person.thread": { service: "crm", method: "GET", path: "/orgs/people/timeline", asRun: true },
  "crm.whatsapp.reach": { service: "crm", method: "POST", path: "/orgs/whatsapp/reach", asRun: true },
  "crm.whatsapp.sent": { service: "crm", method: "GET", path: "/orgs/whatsapp/messages", asRun: true },
  "crm.whatsapp.send": { service: "crm", method: "POST", path: "/orgs/whatsapp/messages", asRun: true },
  "crm.team.membership": { service: "crm", method: "POST", path: "/orgs/people/team-membership", asRun: true },
  "crm.meeting.book": { service: "crm", method: "POST", path: "/orgs/gohighlevel/bookings", asRun: true },
  "lead.detail": { service: "lead", method: "GET", path: "/orgs/leads/{id}", asRun: true },
  "lead.relationship": { service: "lead", method: "GET", path: "/orgs/leads/{id}/relationship", asRun: true },
  "lead.history": { service: "lead", method: "GET", path: "/orgs/leads/{id}/history", asRun: true },
  "lead.followup_date.read": { service: "lead", method: "GET", path: "/orgs/leads/{id}/followup-date", asRun: true },
  "lead.followup_date.set": { service: "lead", method: "PUT", path: "/orgs/leads/{id}/followup-date", asRun: true },
  "lead.followup.record": { service: "lead", method: "POST", path: "/orgs/leads/{id}/followups", asRun: true },
  "lead.followup.claim": { service: "lead", method: "POST", path: "/orgs/campaigns/{campaignId}/followups/claim-next", asRun: true },
  "brand.profile": { service: "brand", method: "GET", path: "/internal/brands/{id}", asRun: true },
  "brand.fields": { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/user-fields", asRun: true },
  "brand.sales_rep": { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/sales-rep", asRun: true },
  "brand.offer.economics": { service: "brand", method: "GET", path: "/internal/offers/{offerId}/economics", asRun: true },
  "brand.offer.answers": { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/answers", asRun: true },
  "brand.offer.documents": { service: "brand", method: "GET", path: "/internal/offers/{offerId}/documents", asRun: true },
  "brand.offer.fields": { service: "brand", method: "GET", path: "/orgs/brands/{brandId}/offers/{offerId}/user-fields", asRun: true },
  "campaign.detail": { service: "campaign", method: "GET", path: "/campaigns/{id}", asRun: true },
  "campaign.predecessor": { service: "campaign", method: "GET", path: "/internal/campaigns/{campaignId}/predecessor", asRun: true },
  "features.trigger": { service: "features", method: "GET", path: "/internal/catalogue/triggers/{triggerId}", asRun: true },
  "content.generations.by_lead": { service: "content-generation", method: "GET", path: "/generations/by-lead/{leadId}", asRun: true },
  "scraping.page": { service: "scraping", method: "POST", path: "/scrape", asRun: true },
  "instantly.conversation": { service: "instantly", method: "GET", path: "/orgs/conversations", asRun: true },
  "instantly.reply.send": { service: "instantly", method: "POST", path: "/orgs/replies", asRun: true },
  "instantly.reply.escalate": { service: "instantly", method: "POST", path: "/orgs/replies/escalate", asRun: true },
  "email.send": { service: "email-gateway", method: "POST", path: "/orgs/send", asRun: true },
  "chat.judgment": { service: "chat", method: "POST", path: "/orgs/judgments", asRun: true },
  "chat.copilot.lead_turn": { service: "chat", method: "POST", path: "/internal/copilot/lead-turns", asRun: true },
  "apollo.phone.reveal": { service: "apollo", method: "POST", path: "/people/{apolloPersonId}/phone-reveal", asRun: true },
  "apollo.phone.read": { service: "apollo", method: "GET", path: "/people/{apolloPersonId}/phone-reveal", asRun: true },
  "twilio.call.place": { service: "twilio", method: "POST", path: "/calls", asRun: true, runIdInBody: "parentRunId" },
  // The cold email (MIGRATE-1105 S2): what the old cold email steps called, each the producer's own route, as the run.
  // The brand's extracted facts, the template's live head (the template is `template.pick`'s, the LLM `llm.pick`'s),
  // the writer's materials, then the email stored (content-generation declares message_written) before `email.send`.
  "brand.extract_fields": { service: "brand", method: "POST", path: "/orgs/brands/extract-fields", asRun: true },
  "content.template_head": { service: "content-generation", method: "GET", path: "/internal/template-dynasties/{slug}/head", asRun: true },
  "content.materials": { service: "content-generation", method: "POST", path: "/generate/materials", asRun: true },
  "content.generate": { service: "content-generation", method: "POST", path: "/generate", asRun: true },
  // Threads posts, the founder hello, pushed emails and the hot-lead proposal (MIGRATE-1105 S4): what their old
  // steps called, each the producer's own org route.
  "meta.threads.accounts": { service: "meta", method: "GET", path: "/orgs/threads/accounts", asRun: true },
  "meta.threads.publications": { service: "meta", method: "GET", path: "/orgs/threads/publications", asRun: true },
  "meta.threads.publish": { service: "meta", method: "POST", path: "/orgs/threads/accounts/{id}/posts", asRun: true, outcomeInBody: "outcomeKey" },
  // X and LinkedIn posts (SOCIAL-POSTS-ENGINES-1107): social-service's brand accounts (typed, publishable or why not),
  // what was published on them, and ONE post on one of them; social-service declares the Unit under the Engine's outcome.
  "social.accounts": { service: "social", method: "GET", path: "/orgs/social/accounts", asRun: true },
  "social.publications": { service: "social", method: "GET", path: "/orgs/social/publications", asRun: true },
  "social.publish": { service: "social", method: "POST", path: "/orgs/social/accounts/{id}/posts", asRun: true, outcomeInBody: "outcomeKey" },
  // industry_news_found (social-service, INDUSTRY-NEWS-ENGINE-1108): one scan of the industry's fresh news for the run's
  // brand (treg held + actualized on social-service's run under the script's; one Unit per item new for the brand, declared
  // under the Engine's outcome), and the kept items any script reads back (one watch, never a second scan).
  "social.news.scan": { service: "social", method: "POST", path: "/orgs/social/industry-news/scans", asRun: true, outcomeInBody: "outcomeKey" },
  "social.news.items": { service: "social", method: "GET", path: "/orgs/social/industry-news", asRun: true },
  // backlink_earned (scraping-service, BACKLINK-ENGINE-1109): one check of the links to the run's brand site (treg held +
  // actualized on scraping-service's run under the script's; each new link verified live and declared as one Unit under
  // the Engine's outcome), the brand's kept links read back, and its link gap (domains linking to its competitors, not to
  // it: treg metered the same way, no Unit, material for an outreach script).
  "scraping.backlinks.check": { service: "scraping", method: "POST", path: "/orgs/backlinks/checks", asRun: true, outcomeInBody: "outcomeKey" },
  "scraping.backlinks.list": { service: "scraping", method: "GET", path: "/orgs/backlinks", asRun: true },
  "scraping.backlinks.link_gap": { service: "scraping", method: "POST", path: "/orgs/backlinks/link-gaps", asRun: true },
  "scraping.site.map": { service: "scraping", method: "POST", path: "/map", asRun: true },
  // LISTICLE-OUTREACH-1110: one person's work email (apollo-service's finder: treg or Explee, metered on the caller's
  // run, idempotent per person, the address verified before it is served).
  "apollo.email.find": { service: "apollo", method: "POST", path: "/email-finder/find", asRun: true },
  "content.thread.generate": { service: "content-generation", method: "POST", path: "/generate-thread", asRun: true },
  "content.whatsapp.generate": { service: "content-generation", method: "POST", path: "/generate-whatsapp", asRun: true },
  "crm.people.list": { service: "crm", method: "GET", path: "/orgs/people", asRun: true },
  "chat.copilot.proactive_turn": { service: "chat", method: "POST", path: "/internal/copilot/proactive-turns", asRun: true },
  // The follow-ups (MIGRATE-1105 S4b): the figures a campaign's brief asks for, read for the person (figure-reader.ts).
  "workflow.figures.read": { service: "workflow", method: "POST", path: "/orgs/figures/read", asRun: true },
};
export const APOLLO_EMAIL_VERIFY = "apollo.email.verify";
export const APOLLO_APIFY_AVAILABLE = "apollo.apify.available";
export const SCRIPT_VENDORS = [LLM_COMPLETE, CHAT_COMPLETE, JEV_NOUL, VOICE_READ, BOOKING_SLOTS, JEV_CHOICE, LLM_PICK, TEMPLATE_PICK, ...Object.keys(SERVICE_DOOR_VENDORS)] as const;

/** Response schemas a script may name instead of spelling one (Anthropic needs a strict schema). */
export const NAMED_RESPONSE_SCHEMAS: Record<string, Record<string, unknown>> = {
  email_sequence: {
    type: "object",
    additionalProperties: false,
    required: ["subject", "emails"],
    properties: {
      subject: { type: "string" },
      emails: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["body", "daysSinceLastStep"],
          properties: { body: { type: "string" }, daysSinceLastStep: { type: "integer" } },
        },
      },
    },
  },
};

export const VOICE_SKILL_SLUG = "client-comms";

/** The owner's ban (2026-10-09): nothing goes to Haiku 4.5. */
export function isBannedModel(model: string): boolean {
  return /haiku[-_. ]?4/i.test(model);
}

const refuse = (error: string): VendorAnswer => ({ ok: false, data: { error } });

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** chat-service `/complete` fields a script may state, passed through verbatim (the door owns their meaning). */
const PASSTHROUGH_FIELDS = ["responseFormat", "temperature", "maxTokens", "webSearch", "disableThinking", "thinkingLevel", "effort"] as const;

/**
 * The completion body, VERBATIM: nothing is added to the script's prompt (a classifier and a writer differ; a writer
 * that wants our voice reads it with `voice.read`). The system prompt, provider and model are the call's, else the
 * script's tactic `systemPrompt`; the provider and model are always the call's (what `llm.pick` read off the script's tactics); missing =
 * refused, never a default.
 */
function completionBody(args: Record<string, unknown>, ctx: VendorCallContext): { body: Record<string, unknown> } | { error: string } {
  const message = str(args.message);
  if (!message) return { error: "needs a message" };
  // The LLM is stated on the call (what `llm.pick` read off the script's tactic for this call, SCRIPT-VALUE-RATING-1113-WF2).
  const provider = str(args.provider);
  const model = str(args.model);
  if (!provider || !model) return { error: "needs an LLM: state the provider and model `llm.pick` answered for this call" };
  if (isBannedModel(model)) return { error: `refuses ${model}: nothing goes to Haiku 4.5` };
  const systemPrompt = typeof args.systemPrompt === "string" ? args.systemPrompt : str(ctx.tactics.systemPrompt);
  if (systemPrompt === null || systemPrompt === undefined) return { error: "needs a systemPrompt: state it in the call or in the script's tactic `systemPrompt`" };
  const body: Record<string, unknown> = { message, systemPrompt, provider, model };
  if (typeof args.responseSchema === "string") {
    const named = NAMED_RESPONSE_SCHEMAS[args.responseSchema];
    if (!named) return { error: `no response schema named ${args.responseSchema} (known: ${Object.keys(NAMED_RESPONSE_SCHEMAS).join(", ")})` };
    body.responseFormat = "json";
    body.responseSchema = named;
  } else if (args.responseSchema && typeof args.responseSchema === "object") {
    // A spelled schema is passed as stated (chat-service enforces JSON from the schema alone), byte for byte the
    // request the service path sends.
    body.responseSchema = args.responseSchema;
  }
  for (const f of PASSTHROUGH_FIELDS) if (args[f] !== undefined) body[f] = args[f];
  // BRAND-MCP-1109: the brand's own MCP tools on this call (chat-service runs a bounded tool loop when the brand
  // plugged a server, else today's one-shot call). Each tier names the brand the way its endpoint reads it:
  // `/complete` reads the org off the run's `x-org-id`; `/internal/platform-complete` takes it in the body.
  if (args.brandTools === false) return { body };
  if (args.brandTools !== undefined) {
    // Stated by the script: its brand, or a refusal it can read.
    const bt = args.brandTools as { brandId?: unknown } | null;
    const brandId = bt && typeof bt === "object" ? str(bt.brandId) : null;
    if (!brandId) return { error: "brandTools needs {brandId}" };
    if (ctx.billing === "platform") {
      const orgId = str(ctx.headers["x-org-id"]);
      if (!orgId) return { error: "brandTools needs the run's org: a brand's tools belong to its org, and this platform run names none" };
      body.brandTools = { orgId, brandId };
    } else {
      body.brandTools = { brandId };
    }
    return { body };
  }
  // BRAND-TOOLS-EVERY-SCRIPT-1109: unstated = the run's brand, by default, on every completion of every script (owner
  // 2026-11-09: our AI uses the brand's tools before it writes to its leads and clients). The default never makes a
  // call fail: it is attached only where chat-service serves it, else the call runs exactly as before.
  const defaulted = defaultBrandTools(body, ctx);
  if (defaulted) body.brandTools = defaulted;
  return { body };
}

/**
 * Providers whose one request cannot ground on their own web search AND call tools (chat-service refuses the pair with
 * a 400 before any spend: Gemini's generateContent). A vendor fact mirrored from chat-service's `brandToolsRefusalFor`,
 * never a script's choice: a call there that asks `webSearch` keeps its web search and runs without the default tools.
 */
const WEB_SEARCH_WITHOUT_TOOLS = new Set(["google"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The run's brand tools a completion gets unasked, or null (no single brand behind the run, or a pair chat-service refuses). */
function defaultBrandTools(body: Record<string, unknown>, ctx: VendorCallContext): Record<string, string> | null {
  const brands = (ctx.headers["x-brand-id"] ?? "").split(",").map((b) => b.trim()).filter(Boolean);
  // One brand = one owner of the tools; a brand set (several) has none to pick without a rule, so the script names it.
  if (brands.length !== 1 || !UUID.test(brands[0]!)) return null;
  if (body.webSearch && body.webSearch !== "false" && WEB_SEARCH_WITHOUT_TOOLS.has(String(body.provider))) return null;
  if (ctx.billing === "platform") {
    const orgId = str(ctx.headers["x-org-id"]);
    return orgId ? { orgId, brandId: brands[0]! } : null;
  }
  return { brandId: brands[0]! };
}

async function complete(name: string, args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const built = completionBody(args, ctx);
  if ("error" in built) return refuse(`${name} ${built.error}`);
  let answer: Record<string, unknown>;
  try {
    answer = ctx.billing === "platform" ? await deps.platformComplete(built.body, platformHeaders(ctx.headers)) : await deps.complete(built.body, ctx.headers);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  ctx.onCompletion?.({ sent: built.body, raw: answer });
  if (name === CHAT_COMPLETE) {
    const json = answer.json;
    if (!json || typeof json !== "object" || Array.isArray(json)) return refuse("chat.complete: the model answered no JSON object");
    return { ok: true, data: json as Record<string, unknown> };
  }
  return {
    ok: true,
    data: {
      content: answer.content ?? null,
      json: answer.json ?? null,
      model: answer.model ?? null,
      tokensInput: answer.tokensInput ?? null,
      tokensOutput: answer.tokensOutput ?? null,
      // BRAND-MCP-1109: how many brand tool calls the model made (served only when the brand has a server plugged;
      // each call is a `brand-mcp-tool-call` event on chat-service's run, a child of the script's run).
      ...(typeof answer.brandToolCalls === "number" ? { brandToolCalls: answer.brandToolCalls } : {}),
    },
  };
}

async function jevNoul(args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const questions = args.questions as Record<string, { instructions?: unknown; whenTrue?: unknown; whenFalse?: unknown }> | undefined;
  if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) return refuse("jev.noul needs questions");
  const wire: Record<string, Record<string, unknown>> = {};
  for (const [k, q] of Object.entries(questions)) {
    const instructions = str(q?.instructions);
    if (!instructions) return refuse(`jev.noul question ${k} needs instructions`);
    wire[k] = { type: "noul", instructions, ...(str(q.whenTrue) && str(q.whenFalse) ? { criteria: { true: q.whenTrue, false: q.whenFalse } } : {}) };
  }
  let out: Record<string, unknown>;
  try {
    const body = { ...(args.state !== undefined ? { state: args.state } : {}), questions: wire };
    out = ctx.billing === "platform" ? await deps.platformJudge(body, platformHeaders(ctx.headers)) : await deps.judge(body, ctx.headers);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  const answers = (out.answers ?? {}) as Record<string, Record<string, unknown>>;
  const probabilities: Record<string, number> = {};
  for (const k of Object.keys(wire)) {
    const p = answers[k]?.noul;
    if (typeof p !== "number" || !Number.isFinite(p) || p < 0 || p > 1) return refuse(`jev.noul: judgment ${k} answered without a readable probability`);
    probabilities[k] = p;
  }
  return { ok: true, data: { probabilities, model: out.model ?? null } };
}

async function jevChoice(args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const questions = args.questions as Record<string, { type?: unknown; instructions?: unknown; criteria?: unknown }> | undefined;
  if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) return refuse("jev.choice needs questions");
  for (const [k, q] of Object.entries(questions)) {
    if (q?.type !== "choice") return refuse(`jev.choice question ${k} must be type choice`);
    if (!str(q.instructions)) return refuse(`jev.choice question ${k} needs instructions`);
    if (!q.criteria || typeof q.criteria !== "object" || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2) return refuse(`jev.choice question ${k} needs at least two criteria`);
  }
  let out: Record<string, unknown>;
  try {
    // Passed as stated: the request is byte for byte the one the service's own code sent (a replay compares it).
    const body = { ...(args.state !== undefined ? { state: args.state } : {}), questions };
    out = ctx.billing === "platform" ? await deps.platformJudge(body, platformHeaders(ctx.headers)) : await deps.judge(body, ctx.headers);
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
  const answers = (out.answers ?? {}) as Record<string, Record<string, unknown>>;
  for (const k of Object.keys(questions)) {
    const a = answers[k];
    if (!a || typeof a.choice !== "string" || !a.probabilities || typeof a.probabilities !== "object") return refuse(`jev.choice: judgment ${k} answered without a choice`);
  }
  return { ok: true, data: { answers, model: out.model ?? null, usage: out.usage ?? null } };
}

async function voiceRead(deps: VendorDeps): Promise<VendorAnswer> {
  const skill = await deps.readSkill(VOICE_SKILL_SLUG).catch(() => null);
  const content = typeof skill?.content === "string" ? skill.content.trim() : "";
  if (!content) return refuse(`voice.read: our voice (${VOICE_SKILL_SLUG}) could not be read`);
  return { ok: true, data: { content, version: typeof skill?.version === "number" ? skill.version : null } };
}

async function bookingSlots(args: Record<string, unknown>, deps: VendorDeps): Promise<VendorAnswer> {
  const url = str(args.bookingUrl);
  const tz = str(args.timezone);
  if (!url || !tz) return refuse("booking.slots needs bookingUrl and timezone");
  if (!deps.readBookingSlots) return refuse("booking.slots: no booking page reader on this host");
  try {
    return { ok: true, data: await deps.readBookingSlots(url, tz) };
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

/**
 * A door whose service is BOOTING (a deploy swapping its container) is asked again inside the run, never failed:
 * a 503 « Service starting: database migrations in progress » (the services' readiness gate) or a refused connection
 * (the new container not listening yet: the request never reached it, so asking again is write-safe). INCIDENT
 * 2026-11-06 18:05 UTC: 4 lead.serve « Service starting » answers during a lead-service deploy were counted as the
 * script's errors and rolled lead_found back for every org. Bounded: BOOT_WAIT_MAX_MS in all, then the last answer
 * stands (a service that never comes up fails the run loudly as before).
 */
export const BOOT_WAIT_MAX_MS = 120_000;
const BOOT_WAIT_STEP_MS = 5_000;
export const isBooting = (out: { status: number; body: Record<string, unknown> }) =>
  out.status === 503 && /service starting|migrations in progress/i.test(String(out.body.error ?? ""));
function connectionRefused(e: unknown): boolean {
  const seen = new Set<unknown>();
  for (let cur: unknown = e; cur && typeof cur === "object" && !seen.has(cur); cur = (cur as { cause?: unknown }).cause) {
    seen.add(cur);
    if ((cur as { code?: unknown }).code === "ECONNREFUSED") return true;
  }
  return false;
}
async function askThroughBoot(
  ask: () => Promise<{ status: number; body: Record<string, unknown> }>,
  deps: VendorDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let waited = 0; ; waited += BOOT_WAIT_STEP_MS) {
    try {
      const out = await ask();
      if (!isBooting(out) || waited >= BOOT_WAIT_MAX_MS) return out;
    } catch (e) {
      if (!connectionRefused(e) || waited >= BOOT_WAIT_MAX_MS) throw e;
    }
    await sleep(BOOT_WAIT_STEP_MS);
  }
}

/** One service door call: the run's identity + tracking, and whose in-flight work it is (the caller's run). */
async function serviceDoor(name: string, args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  const door = SERVICE_DOOR_VENDORS[name]!;
  if (door.asRun) return runDoor(name, door, args, ctx, deps);
  // Every field is required: a string (non-blank), a number, or a list/object, passed as stated (a GET sends text).
  const fields: Record<string, unknown> = {};
  for (const f of door.args) {
    const v = args[f];
    const present = typeof v === "string" ? v.trim() !== "" : typeof v === "number" ? Number.isFinite(v) : v !== null && typeof v === "object";
    if (!present) return refuse(`${name} needs ${door.args.join(", ")}`);
    fields[f] = v;
  }
  // Optional fields pass as stated when present (never a default).
  for (const f of door.optional ?? []) if (args[f] !== undefined) fields[f] = args[f];
  if (!ctx.callerRunId || !ctx.headers["x-run-id"]) return refuse(`${name} serves only a run a service asked for`);
  const headers = { ...ctx.headers, "x-caller-run-id": ctx.callerRunId };
  try {
    const path = door.method === "GET" ? `${door.path}?${new URLSearchParams(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])))}` : door.path;
    const out = await askThroughBoot(() => deps.serviceDoor(door.service, door.method, path, door.method === "GET" ? null : fields, headers), deps);
    if (out.status !== 200) return refuse(String(out.body.error ?? `${door.service}-service answered ${out.status}`));
    if (door.okFrom) return { ok: out.body[door.okFrom] === true, data: {} };
    return { ok: true, data: out.body };
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

/** Identity headers a run door call may drop (a rep alert is not the campaign speaking): never whose run or org it is. */
const KEPT_HEADERS = new Set(["x-org-id", "x-run-id", "x-api-key"]);
/** A run door's bounded poll: at most this long (the run's wall is 10 min). */
const POLL_MAX_SECONDS = 300;

function plainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function readDotted(body: Record<string, unknown>, field: string): unknown {
  let at: unknown = body;
  for (const part of field.split(".")) at = plainRecord(at) ? at[part] : undefined;
  return at;
}

/** One run door call: the step's request, as the script's run; the producer's whole answer, refusals included. */
async function runDoor(name: string, door: Extract<ServiceDoor, { asRun: true }>, args: Record<string, unknown>, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  if (!ctx.headers["x-run-id"] || !ctx.headers["x-org-id"]) return refuse(`${name} acts only as a run of an org`);
  const params = args.params ?? {};
  const query = args.query ?? {};
  if (!plainRecord(params) || !plainRecord(query)) return refuse(`${name}: params and query are objects`);
  let path = door.path;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string" && typeof v !== "number") return refuse(`${name}: param ${k} is a string or a number`);
    if (String(v).trim() === "") return refuse(`${name}: param ${k} is empty`);
    path = path.replace(`{${k}}`, encodeURIComponent(String(v)));
  }
  const unfilled = path.match(/\{(\w+)\}/);
  if (unfilled) return refuse(`${name} needs params.${unfilled[1]}`);
  const q = Object.entries(query).filter(([, v]) => v !== undefined && v !== null);
  if (q.length > 0) path += `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)]))}`;
  let body: Record<string, unknown> | null = null;
  if (door.method !== "GET") {
    if (args.body !== undefined && !plainRecord(args.body)) return refuse(`${name}: body is an object`);
    body = (args.body as Record<string, unknown> | undefined) ?? {};
  } else if (args.body !== undefined) return refuse(`${name} is a read: it takes no body`);
  if (door.runIdInBody && body) {
    if (door.runIdInBody in body) return refuse(`${name}: ${door.runIdInBody} is the script's run, filled by the door`);
    body = { ...body, [door.runIdInBody]: ctx.headers["x-run-id"] };
  }
  if (door.outcomeInBody && body && ctx.outcome) {
    if (door.outcomeInBody in body) return refuse(`${name}: ${door.outcomeInBody} is the script's Engine outcome, filled by the door`);
    body = { ...body, [door.outcomeInBody]: ctx.outcome };
  }
  const headers = { ...ctx.headers };
  if (args.omitHeaders !== undefined) {
    if (!Array.isArray(args.omitHeaders) || args.omitHeaders.some((h) => typeof h !== "string")) return refuse(`${name}: omitHeaders is a list of header names`);
    for (const h of args.omitHeaders as string[]) {
      if (KEPT_HEADERS.has(h.toLowerCase())) return refuse(`${name}: ${h} is never dropped`);
      delete headers[h.toLowerCase()];
    }
  }
  const poll = args.pollWhile;
  if (poll !== undefined && (!plainRecord(poll) || typeof poll.field !== "string")) return refuse(`${name}: pollWhile is {field, equals, intervalSeconds?, timeoutSeconds?, throwWhenTimedOut?}`);
  const ask = () => askThroughBoot(() => deps.serviceDoor(door.service, door.method, path, body, headers), deps);
  try {
    let out = await ask();
    if (poll) {
      // The old step's bounds, byte for byte (scripts/nodes/http-call.ts): 1-60 s between asks, 0-300 s in all.
      const interval = Math.max(1, Math.min(60, Number(poll.intervalSeconds ?? 5))) * 1000;
      const deadline = Date.now() + Math.max(0, Math.min(POLL_MAX_SECONDS, Number(poll.timeoutSeconds ?? 60))) * 1000;
      const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let timedOut = false;
      while (out.status >= 200 && out.status < 300 && readDotted(out.body, poll.field as string) === poll.equals) {
        if (Date.now() + interval > deadline) {
          timedOut = true;
          break;
        }
        await sleep(interval);
        out = await ask();
      }
      if (timedOut && poll.throwWhenTimedOut === true) return refuse(`${name}: still ${String(poll.field)} = ${JSON.stringify(poll.equals)} after the wait`);
      if (timedOut) out = { status: out.status, body: { ...out.body, pollTimedOut: true } };
    }
    if (out.status >= 200 && out.status < 300) return { ok: true, data: out.body };
    const code = typeof out.body.code === "string" ? out.body.code : plainRecord(out.body.details) && typeof out.body.details.code === "string" ? out.body.details.code : null;
    return { ok: false, data: { error: String(out.body.error ?? `${door.service}-service answered ${out.status}`), status: out.status, code, body: out.body } };
  } catch (e) {
    return refuse(e instanceof Error ? e.message : String(e));
  }
}

/** Which Engine and call a writing choice is for: the script's own Engine, or one it asks (tactic `asks`). */
function pickTarget(name: string, args: Record<string, unknown>, ctx: VendorCallContext): { outcome: string; place: string } | { error: string } {
  const q = plainRecord(args.query) ? args.query : {};
  const place = str(args.place) ?? str(q.place);
  if (!place) return { error: `${name} needs a place: the name the script gives this call (writer, angles...)` };
  const own = ctx.outcome ?? null;
  const named = str(args.outcome) ?? str(q.outcome);
  let outcome = own;
  if (named && named !== own) {
    // The Engine that makes the call: the script's own, or one it asks for a Unit (the asked Engine's script makes the
    // call with the asker's LLM, e.g. the cold email hands its writer LLM to message_written).
    const asks = Array.isArray(ctx.tactics.asks) ? (ctx.tactics.asks as unknown[]) : [];
    if (!asks.includes(named)) return { error: `${name}: ${named} is neither this script's Engine nor one it asks (tactic asks)` };
    outcome = named;
  }
  if (!outcome) return { error: `${name}: the run states no Engine outcome` };
  return { outcome, place };
}

/**
 * The value a script's tactics state for one call (SCRIPT-VALUE-RATING-1113-WF2): `<plural>[place]` when the script
 * states one for that call, else `<singular>` (every call of the script). Absent = undefined (the caller refuses).
 */
function tacticFor(tactics: Record<string, unknown>, singular: string, plural: string, place: string): unknown {
  const byPlace = tactics[plural];
  if (plainRecord(byPlace) && byPlace[place] !== undefined) return byPlace[place];
  return tactics[singular];
}

/**
 * One `template.pick`: the TEMPLATE dynasty this script writes with, read off its own tactics (SCRIPT-VALUE-RATING-1113-WF2,
 * owner 2026-11-13 « le LLM et le template sont des tactics du script »): tactic `templates[place]`, else `template`
 * (a template dynasty slug). Another combination is another dynasty, the Rating (features-service's script pick) compares
 * them. None stated = a refusal the script throws on: nothing written, never a default template.
 */
function templatePick(args: Record<string, unknown>, ctx: VendorCallContext): VendorAnswer {
  const t = pickTarget(TEMPLATE_PICK, args, ctx);
  if ("error" in t) return refuse(t.error);
  const slug = str(tacticFor(ctx.tactics, "template", "templates", t.place));
  if (!slug) return refuse(`template.pick ${t.outcome}|${t.place}: this script states no template (tactic template, or templates.${t.place}): nothing is written`);
  const picked = { templateDynastySlug: slug, name: null, head: null };
  return { ok: true, data: { ...picked, place: t.place, outcome: t.outcome, template: picked } };
}

/**
 * One `llm.pick`: the LLM this script calls with, read off its own tactics (SCRIPT-VALUE-RATING-1113-WF2): tactic
 * `llms[place]`, else `llm` (`{provider, model}`, model = chat-service's alias). Another LLM is another dynasty, never
 * a run-time pick. None stated = a refusal the script throws on: nothing written, never a default model.
 */
function llmPick(args: Record<string, unknown>, ctx: VendorCallContext): VendorAnswer {
  const t = pickTarget(LLM_PICK, args, ctx);
  if ("error" in t) return refuse(t.error);
  const llm = tacticFor(ctx.tactics, "llm", "llms", t.place);
  const provider = plainRecord(llm) ? str(llm.provider) : null;
  const model = plainRecord(llm) ? str(llm.model) : null;
  if (!provider || !model) return refuse(`llm.pick ${t.outcome}|${t.place}: this script states no LLM (tactic llm {provider, model}, or llms.${t.place}): nothing is written`);
  if (isBannedModel(model)) return refuse(`llm.pick ${t.outcome}|${t.place}: refuses ${model}: nothing goes to Haiku 4.5`);
  const picked = { provider, model, llmDynastySlug: model, name: plainRecord(llm) ? str(llm.name) : null };
  return { ok: true, data: { ...picked, place: t.place, outcome: t.outcome, llm: picked } };
}

/** Call one vendor for a script. */
export async function callVendor(name: string, args: Record<string, unknown> | null, ctx: VendorCallContext, deps: VendorDeps): Promise<VendorAnswer> {
  if (name === LLM_COMPLETE || name === CHAT_COMPLETE) return complete(name, args ?? {}, ctx, deps);
  if (name === LLM_PICK) return llmPick(args ?? {}, ctx);
  if (name === TEMPLATE_PICK) return templatePick(args ?? {}, ctx);
  if (name === JEV_NOUL) return jevNoul(args ?? {}, ctx, deps);
  if (name === JEV_CHOICE) return jevChoice(args ?? {}, ctx, deps);
  if (name === VOICE_READ) return voiceRead(deps);
  if (name === BOOKING_SLOTS) return bookingSlots(args ?? {}, deps);
  if (name in SERVICE_DOOR_VENDORS) return serviceDoor(name, args ?? {}, ctx, deps);
  return refuse(`no vendor named ${name} (scripts may call: ${SCRIPT_VENDORS.join(", ")})`);
}

/** The production doors (chat-service with its own key). */
export function productionVendorDeps(): VendorDeps {
  const base = (process.env.CHAT_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.CHAT_SERVICE_API_KEY ?? "";
  const need = () => {
    if (!base || !key) throw new Error("CHAT_SERVICE_URL and CHAT_SERVICE_API_KEY must be set for script vendors");
  };
  return {
    async complete(body, headers) {
      need();
      const res = await longRequest(`${base}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /complete -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async judge(body, headers) {
      need();
      const res = await longRequest(`${base}/orgs/judgments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /orgs/judgments -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async platformComplete(body, headers) {
      need();
      const res = await longRequest(`${base}/internal/platform-complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /internal/platform-complete -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async platformJudge(body, headers) {
      need();
      const res = await longRequest(`${base}/internal/platform-judgments`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`chat-service POST /internal/platform-judgments -> ${res.status}: ${text.slice(0, 300)}`);
      return JSON.parse(text) as Record<string, unknown>;
    },
    async serviceDoor(service, method, path, body, headers) {
      const prefix = service.toUpperCase().replace(/-/g, "_");
      const base = (process.env[`${prefix}_SERVICE_URL`] ?? "").replace(/\/$/, "");
      const key = process.env[`${prefix}_SERVICE_API_KEY`] ?? "";
      if (!base || !key) throw new Error(`${prefix}_SERVICE_URL and ${prefix}_SERVICE_API_KEY must be set for its script doors`);
      const res = await longRequest(`${base}${path}`, {
        method,
        headers: { ...(body ? { "content-type": "application/json" } : {}), "x-api-key": key, ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(600_000),
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { error: text.slice(0, 300) };
      }
      return { status: res.status, body: parsed };
    },
    async readBookingSlots(bookingUrl, timezone) {
      // The same reader the old answering step ran (a public page, free, no credential), loaded once as a module.
      const { readBookingSlotsCode } = await import("../booking-slots.js");
      const mod = (await import(`data:text/javascript,${encodeURIComponent(readBookingSlotsCode())}`)) as { main: (u: string, t: string) => Promise<Record<string, unknown>> };
      return mod.main(bookingUrl, timezone);
    },
    async readSkill(slug) {
      need();
      const res = await longRequest(`${base}/internal/skills/${encodeURIComponent(slug)}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(600_000) });
      if (!res.ok) return null;
      return (await res.json()) as { content?: unknown; version?: unknown };
    },
  };
}
