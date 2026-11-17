/**
 * INTRO-BOARDY-1114 (owner 2026-11-14): intro scripts that build TRUST before we sell, Boardy-style.
 *
 * A prospect of the brand gets an intro email so good it creates trust; if they want more, they are offered the brand's
 * existing offer. We stand on both sides: an intro happens only when it is good for both people (double opt-in), the
 * fit is checked before either one hears the other's name, and the AI says no when it is not a fit. One persona for
 * everyone, who remembers every conversation (the Engine's storage).
 *
 * Five scripts, one generator file, every one of them data (tactics) over shared code:
 *
 *  1. `paid_client/dy_intro_path`: a PATH toward Paid client (SCRIPT-VALUE-RATING-1113-WF1 shape). It writes nothing:
 *     a proactive tick asks the Email sent Engine for ONE intro first email, then asks the Message sent Engine to record
 *     it (who was proposed to whom), so the conversation can go on; a Lead event asks the Message sent Engine for the
 *     next step of that intro conversation. It acts only when its campaign's brief asks for intros (Jev, once per brief,
 *     kept): on any other campaign a proactive tick does nothing and a Lead event gets the one answer every lead gets
 *     (exactly `dy_answer_lead_pull`).
 *  2. `email_sent/dy_intro_lead_to_lead`, `dy_intro_open`, `dy_intro_client_to_lead`: ONE code, told apart by the tactic
 *     `intro`. Each reads the material `intro_requested`, which ONLY the path hands: an Engine run of any other campaign
 *     holds no such material, so these scripts are never candidates there (structural, no window while strategies are
 *     judged). Serve one reader (our lead search), research them (their site + the web: checkable facts with their
 *     URL), find the other person (lead to lead: a person of our lead search, picked for a fit good for BOTH; client to
 *     lead: the brand's own person; open: nobody), write in our voice from the campaign brief, send.
 *  3. `message_sent/dy_intro_answer`: the intro conversation (owner's steps a-d), in the SAME campaign: records what
 *     the first email proposed, then answers each Lead event of a person of an intro thread: ask the other person
 *     (double opt-in), introduce both in one email (both on it), one intro at a time; what is free, when we offer to go
 *     on paid and when we ask for clients' emails is the campaign's brief (INTRO-BOARDY-LEVEL-1117); a reader who
 *     declines is never offered an intro again (kept in storage). A lead of an intro thread is held by this campaign (`answering_leads`, with a
 *     `holdUntil`), so no other campaign of the brand answers its leads.
 *
 * Writers play a game at Boardy's level (goal, a few truths, Boardy's own emails as the level: INTRO-BOARDY-LEVEL-1117),
 * never a list of what a message must contain; no money in a first email. Every LLM is a tactic of its script (`llms[place]`, read
 * by `llm.pick`), never a model in code.
 */
import { PORT_HEAD } from "./port-kit.js";
import { CONVERSATION_LEVEL, FIRST_EMAIL_GAME, FIRST_EMAIL_LEVEL } from "./intro-level.js";

/** The material only the intro path hands: what makes an intro script a candidate at all. */
export const INTRO_MATERIAL = "intro_requested";

/** The question Jev answers once per brief: does this campaign ask for intros at all? */
export const BRIEF_ASKS_INTROS =
  "The state is a campaign brief a client wrote. Does it ask the campaign to offer introductions between people (warm introductions: proposing to a prospect a person to meet, or asking them who they want to meet)? A brief that asks only to pitch the client's offer, or says the cold email pitches the offer only, does not.";

/** How long a lead of an intro thread is held by its campaign once we wrote to them. */
export const INTRO_HOLD_DAYS = 60;

const RESEARCH_LLM = { provider: "anthropic", model: "sonnet" } as const;
const WRITER_LLM = { provider: "anthropic", model: "opus" } as const;

/** Who writes (a tactic): the persona fact and the signature say it is an AI; no rule about saying it (owner 2026-11-17). */
const PERSONA = {
  name: "Sophie",
  says: "an AI specialized in introducing people to clients",
};
/** The signature appended after the writer's text (a tactic), one line each. */
const SIGNATURE = "Sophie\nAI introductions, distribute.you";

export const INTRO_PATH = {
  outcome: "paid_client",
  dynasty: "dy_intro_path",
  tactics: {
    asks: ["email_sent", "message_sent"],
    intro: "path",
    // The payment is the lead's own fact (billing, the client's payment connector): this run declares nothing.
    recorded_by: "billing",
    relationships: "pure_prospect",
    briefQuestion: BRIEF_ASKS_INTROS,
  },
  description:
    "Works toward a paid client by building trust with introductions: asks for one intro email to a prospect, then carries each intro conversation (double opt-in, the introduction, then the client's own goal). Only on a campaign whose brief asks for intros; on any other campaign a lead who writes gets the usual answer. Leads only.",
} as const;

const FIRST_EMAIL_COMMON = {
  recorded_by: "instantly",
  sendTag: "intro-email",
  llms: { research: RESEARCH_LLM, match: WRITER_LLM, writer: WRITER_LLM },
  persona: PERSONA,
  signature: SIGNATURE,
  /** Fresh people served per run as candidates for the other person (lead to lead), beside the ones kept. */
  freshCandidates: 2,
  /** People kept as candidates (served, researched, not yet introduced), newest first. */
  poolMax: 40,
  poolDays: 60,
  serve: { excludeEmailedWithin: "never" },
} as const;

export const INTRO_LEAD_TO_LEAD = {
  outcome: "email_sent",
  dynasty: "dy_intro_lead_to_lead",
  tactics: { ...FIRST_EMAIL_COMMON, intro: "lead_to_lead" },
  description:
    "Offers an introduction: writes one first email to a new prospect proposing ONE other person found through our lead search, a person it is good for both to meet, with checkable facts on both people and no price. Pitches no offer.",
} as const;

export const INTRO_OPEN = {
  outcome: "email_sent",
  dynasty: "dy_intro_open",
  tactics: { ...FIRST_EMAIL_COMMON, intro: "open" },
  description:
    "Offers introductions: writes one first email to a new prospect, with checkable facts on them, saying it is an AI that makes introductions and asking who they would like to meet. Names nobody, no price. Pitches no offer.",
} as const;

export const INTRO_CLIENT_TO_LEAD = {
  outcome: "email_sent",
  dynasty: "dy_intro_client_to_lead",
  tactics: { ...FIRST_EMAIL_COMMON, intro: "client_to_lead" },
  description:
    "Offers an introduction: writes one first email to a new prospect proposing to introduce them to a person of the client's own team, only when it is good for both, with checkable facts on both people and no price. Pitches no offer.",
} as const;

export const INTRO_FIRST_EMAILS = [INTRO_LEAD_TO_LEAD, INTRO_OPEN, INTRO_CLIENT_TO_LEAD] as const;

export const INTRO_ANSWER = {
  outcome: "message_sent",
  dynasty: "dy_intro_answer",
  tactics: {
    intro: "conversation",
    recorded_by: "sender",
    relationships: "pure_prospect",
    llms: { research: RESEARCH_LLM, match: WRITER_LLM, writer: WRITER_LLM },
    persona: PERSONA,
    signature: SIGNATURE,
    freshCandidates: 3,
    holdDays: INTRO_HOLD_DAYS,
  },
  description:
    "Carries an intro conversation by email: asks the other person before any intro (double opt-in), introduces both people in one email once both said yes, one intro at a time with whoever fits best, as the campaign's brief says. A reader who declines is never offered an intro again. Leads only.",
} as const;

/** The tactic value every EXISTING email writer carries: it pitches the offer, it offers no intro. */
export const OFFER_PITCH_TACTIC = { intro: "none", pitches: "offer" } as const;

// ---------------------------------------------------------------------------------------------------------------
// Prompts (data of the scripts: changed by an UPGRADE of the dynasty, never per brand).
// ---------------------------------------------------------------------------------------------------------------

export const RESEARCH_PROMPT = [
  "You research ONE person and their company, so an AI that makes introductions can write to them with facts they can check.",
  "Search the web: their company site, their LinkedIn or X posts, articles, podcasts, launches, client stories. The material below (their profile and their own site) comes first.",
  "Return only facts you read on a page, each with that page's URL. A good fact is precise and recent: a number, a launch, a client named, a post they wrote and what it said, a problem they described in their own words. Quote their own words when you have them.",
  "Never a guess, never an opinion, never an adjective about them. A fact you could not tie to a page is left out.",
  "sells: what their company sells, in plain words. sellsTo: to whom (kind of company, size, market).",
  "looksFor: what they visibly look for (customers of a kind, partners, hires, advice), each from a fact. canBring: what they could bring to someone else, each from a fact.",
  "When you find nothing beyond the material, return what the material states, with the site's URL.",
].join("\n");

export const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sells", "sellsTo", "facts", "looksFor", "canBring"],
  properties: {
    sells: { type: "string" },
    sellsTo: { type: "string" },
    facts: {
      type: "array",
      items: { type: "object", additionalProperties: false, required: ["fact", "url"], properties: { fact: { type: "string" }, url: { type: "string" } } },
    },
    looksFor: { type: "array", items: { type: "string" } },
    canBring: { type: "array", items: { type: "string" } },
  },
} as const;

export const MATCH_PROMPT = [
  "You are an AI superconnector. You stand on BOTH sides: an introduction is made only when it is good for both people, and you say no when it is not a fit.",
  "You get ONE reader and a numbered list of candidates, each with facts. Pick the ONE candidate the reader would most want to meet AND who would most want to meet the reader: one sells or brings what the other visibly looks for, at a matching size and market, with a concrete reason from the facts on BOTH sides.",
  "When no candidate gives both people a concrete reason, answer -1. A vague reason (both are founders, both do B2B) is no reason.",
  "forReader: why meeting them is good for the reader, from the facts only. forThem: why meeting the reader is good for them, from the facts only. Both empty when you answer -1. Never a word about money, price or cost in either.",
].join("\n");

export const MATCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["pick", "forReader", "forThem"],
  properties: { pick: { type: "integer" }, forReader: { type: "string" }, forThem: { type: "string" } },
} as const;

/**
 * The first email (INTRO-BOARDY-LEVEL-1117): the goal, a few truths, Boardy's emails as the level, validated word for
 * word by the owner. Deleted, never kept beside it: "Every sentence carries a fact", "What we know about the reader comes
 * first", "Plain short sentences, one idea each", the rule about saying it is an AI, and every list of what the email
 * must contain (« trop précis et robotique »).
 */
export const FIRST_EMAIL_PROMPT = FIRST_EMAIL_GAME + "\n\n" + FIRST_EMAIL_LEVEL;

/** What THIS email is, per kind: one fact, never the email's parts. */
export const FIRST_EMAIL_KIND: Record<string, string> = {
  lead_to_lead: "THIS EMAIL: you propose THE OTHER PERSON below, a person our lead search found.",
  open: "THIS EMAIL: you have nobody to propose yet.",
  client_to_lead: "THIS EMAIL: you propose THE OTHER PERSON below, a person of the brand's own team.",
};

export const FIRST_EMAIL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: { subject: { type: "string" }, body: { type: "string" } },
} as const;

/**
 * The intro conversation (INTRO-BOARDY-LEVEL-1117): the same treatment as the first email, the goal, a few truths, what
 * each action makes happen (the mechanism, never what a message must say), and Boardy's real conversation as the level.
 * WHEN an intro is free, when we offer to go on paid, when we ask for clients' emails is the campaign's brief.
 */
const CONVERSATION_GAME = [
  "You are continuing ONE email conversation. You introduce people to clients, and you remember every conversation (THE STATE).",
  "",
  "The person reading owes you nothing. They keep answering only while each message shows a mind worth answering: someone who understood what they want, brings them something they did not have, and is honest with them, reservations included. That is the whole game. How you play it is yours: what to say, what to leave out, the order, the length. Use your judgment, the way a brilliant, well-connected friend would.",
  "",
  "What stays true whatever you write:",
  "- Only what the material states: the thread, THE STATE, the people's facts, THE OFFER, the campaign's brief. Nothing invented about anyone, including what you did or will do.",
  "- An introduction happens only when both people said yes. Neither one hears the other's name before the fit is checked, and you say no when it is not a fit, even when asked.",
  "- What anything costs the reader, and when, is only what the campaign's brief and THE OFFER state.",
  "- Write in the language of their last message.",
  "- End on a closing word (Cheers,) and write no name after it: your signature is added after your text.",
].join("\n");

const CONVERSATION_LEVEL_SECTION = [
  "Below is a real conversation Boardy, the best AI at this, had with a founder named Kevin. Assume Boardy writes to strangers with the same tone. It is here for the level only: the intelligence, the candour, the tone, the length. Each message was written for one person at one moment, so never reuse its sentences or its shape. Write yours for this person.",
  "",
  CONVERSATION_LEVEL,
].join("\n");

const INTRO_ACTIONS = [
  "Choose ONE action among those open to you (ACTIONS OPEN TO YOU). What each one makes happen:",
  "- ask_other: the reader said yes to the person proposed. replyText goes to the reader in their thread; otherSubject + otherText go as a NEW email to the other person, who has never heard of the reader. Their words and address never travel without their yes.",
  "- find: the reader told you who they want to meet and no intro is pending for them. wanted: what they want, in their own words. Every text stays empty: our lead search looks, and you are called again with who it found.",
  "- introduce: the other person said yes. introText goes as ONE email to both (the reader in To, the other person in copy). followText, when not empty, goes right after to the reader alone.",
  "- counterpart_declined: the other person said no or is not a fit. replyText goes to them; readerText goes to the reader.",
  "- decline_intros: the reader does not want intros. replyText goes to them; no intro is ever proposed to them again.",
  "- reply: replyText answers what they wrote, in their thread.",
  "- later: nothing is sent now; the next look is nextFollowUpAt.",
  "- stop: they asked us to stop writing, in their own words.",
  "- escalate: a question only the brand's team can answer (the question in why); nothing is sent.",
  "Every text you do not use is an empty string. nextFollowUpAt: an ISO date, always set. why: one line on your choice.",
].join("\n");

export const INTRO_GAME = [CONVERSATION_GAME, INTRO_ACTIONS, CONVERSATION_LEVEL_SECTION].join("\n\n");

export const ANSWER_ACTIONS = ["ask_other", "find", "introduce", "counterpart_declined", "decline_intros", "reply", "later", "stop", "escalate"] as const;

export function answerSchema(actions: readonly string[]): Record<string, unknown> {
  const text = { type: "string" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["action", "replyText", "readerText", "otherSubject", "otherText", "introText", "followText", "wanted", "nextFollowUpAt", "why"],
    properties: {
      action: { type: "string", enum: [...actions] },
      replyText: text,
      readerText: text,
      otherSubject: text,
      otherText: text,
      introText: text,
      followText: text,
      wanted: text,
      nextFollowUpAt: text,
      why: text,
    },
  };
}

/** The proposal after the reader said who they want to meet: same game, same level, one fact about THIS message. */
export const PROPOSE_PROMPT = [
  CONVERSATION_GAME,
  "THIS MESSAGE: the reader told you who they want to meet (WHAT THEY WANT). Our lead search looked: THE ONE WHO FITS below is the person it found good for both of you, who has not been contacted yet, or nobody fits. replyText is sent to the reader in their thread.",
  CONVERSATION_LEVEL_SECTION,
].join("\n\n");

export const PROPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["replyText"],
  properties: { replyText: { type: "string" } },
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Shared source: helpers every intro script carries (the sandbox has no imports).
// ---------------------------------------------------------------------------------------------------------------

const SHARED = `
const BRIEF_HEADER = "";
${PORT_HEAD}
const RESEARCH_PROMPT = ${JSON.stringify(RESEARCH_PROMPT)};
const RESEARCH_SCHEMA = ${JSON.stringify(RESEARCH_SCHEMA)};
const MATCH_PROMPT = ${JSON.stringify(MATCH_PROMPT)};
const MATCH_SCHEMA = ${JSON.stringify(MATCH_SCHEMA)};
const SITE_MAX_CHARS = 12000;

const s = (v: any): string => (typeof v === "string" && v.trim() !== "" ? v.trim() : "");
/** Plain text whatever the writer returned (it may mirror the HTML of the thread): paragraphs kept, tags dropped. */
const plain = (t: any): string => String(t ?? "")
  .replace(/<\\/p>\\s*<p[^>]*>/gi, "\\n\\n").replace(/<br\\s*\\/?>/gi, "\\n").replace(/<[^>]+>/g, "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, String.fromCharCode(34)).replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const undash = (t: any): string => plain(t).replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ").trim();
const escapeHtml = (t: string): string => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const toHtml = (t: string): string => t.split(/\\n\\s*\\n/).map((p) => p.trim()).filter(Boolean).map((p) => "<p>" + escapeHtml(p).replace(/\\n/g, "<br>") + "</p>").join("");
const hostOf = (u: any): string => { try { return new URL(String(u)).hostname.replace(/^www\\./, ""); } catch (_e) { return ""; } };
const emailOf = (v: any): string => { const a = s(v).toLowerCase(); return /^[^\\s@<>,;"]+@[^\\s@<>,;"]+\\.[^\\s@<>,;"]+$/.test(a) ? a : ""; };

/** A short, stable key for a brief (no crypto in the sandbox: FNV-1a over the text). */
function briefKey(brief: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < brief.length; i++) { h ^= brief.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "brief:" + h.toString(16) + ":" + brief.length;
}

/** The LLM of one call: the script's tactic for that place (llm.pick). None = the run fails, never a default model. */
function llmFor(ctx: any, place: string): { provider: string; model: string } {
  const p = ctx.vendor.call("llm.pick", { place });
  if (!p.ok) throw new Error("llm.pick " + place + ": " + String(p.data && p.data.error) + ". Nothing is written.");
  return { provider: p.data.provider, model: p.data.model };
}

function complete(ctx: any, place: string, systemPrompt: string, message: string, schema: any, extra?: Record<string, unknown>): any {
  const llm = llmFor(ctx, place);
  const a = must(ctx, "llm.complete", { provider: llm.provider, model: llm.model, systemPrompt, message, responseFormat: "json", responseSchema: schema, ...(extra ?? {}) });
  if (!a.json || typeof a.json !== "object") throw new Error("llm.complete (" + place + ") answered no JSON: " + String(a.content ?? "").slice(0, 300));
  return a.json;
}

/** One served person, in the plain shape every intro step reads. */
function personOf(lead: any): any {
  const d = lead?.data ?? {};
  const o = d.organization ?? {};
  const website = s(o.websiteUrl) || (emailOf(lead?.email) ? "https://" + emailOf(lead.email).split("@")[1] : "");
  return {
    leadId: s(lead?.leadId) || null,
    email: emailOf(lead?.email) || null,
    firstName: s(d.firstName),
    lastName: s(d.lastName),
    title: s(d.currentTitle),
    headline: s(d.headline),
    linkedinUrl: s(d.linkedinUrl),
    city: s(d.city),
    country: s(d.country),
    company: {
      name: s(o.name),
      domain: hostOf(website),
      website,
      industry: s(o.industry),
      size: o.estimatedNumEmployees ?? null,
      description: s(o.shortDescription) || s(o.seoDescription),
      city: s(o.city),
      country: s(o.country),
      linkedinUrl: s(o.linkedinUrl),
      foundedYear: o.foundedYear ?? null,
    },
  };
}

/** Who writes: the persona tactic and the signature appended after the text (both tactics, never a rule in a prompt). */
function whoYouAre(t: any): string {
  const sig = s(t?.signature).split("\\n").map((l: string) => l.trim()).filter(Boolean).join(", ");
  return "WHO YOU ARE: " + s(t?.persona?.name) + ", " + s(t?.persona?.says) + "." + (sig ? " Your signature, added after your text, reads: " + sig : "");
}

function nameOf(p: any): string {
  return [s(p?.firstName), s(p?.lastName)].filter(Boolean).join(" ");
}

function profileLines(p: any): string {
  const c = p.company ?? {};
  return [
    "Name: " + (nameOf(p) || "(unknown)"),
    p.title ? "Title: " + p.title : "",
    p.headline ? "Headline: " + p.headline : "",
    p.linkedinUrl ? "LinkedIn: " + p.linkedinUrl : "",
    [p.city, p.country].filter(Boolean).length ? "Lives in: " + [p.city, p.country].filter(Boolean).join(", ") : "",
    c.name ? "Company: " + c.name + (c.domain ? " (" + c.domain + ")" : "") : "",
    c.industry ? "Industry: " + c.industry : "",
    c.size ? "Company size: " + String(c.size) + " people" : "",
    c.description ? "Company description: " + c.description : "",
    c.foundedYear ? "Founded: " + String(c.foundedYear) : "",
    [c.city, c.country].filter(Boolean).length ? "Company based in: " + [c.city, c.country].filter(Boolean).join(", ") : "",
  ].filter(Boolean).join("\\n");
}

/** Research ONE person: their own site (raw) + the web (checkable facts with their URL). */
function research(ctx: any, p: any, brandId: string, campaignId: string): any {
  const site = p.company?.website ? tolerated(ctx, "scraping.page", { body: { url: p.company.website, enrich: false, brandIds: [brandId], campaignId } }) : { ok: false };
  const siteText = String(site?.result?.rawMarkdown ?? "").slice(0, SITE_MAX_CHARS);
  const r = complete(ctx, "research", RESEARCH_PROMPT, [
    "THE PERSON",
    profileLines(p),
    "",
    "THEIR OWN SITE (" + (p.company?.website || "none") + ")",
    siteText || "(could not be read)",
  ].join("\\n"), RESEARCH_SCHEMA, { webSearch: true });
  const facts = (Array.isArray(r.facts) ? r.facts : []).filter((f: any) => s(f?.fact) && s(f?.url)).slice(0, 12).map((f: any) => ({ fact: undash(f.fact), url: s(f.url) }));
  return {
    sells: s(r.sells),
    sellsTo: s(r.sellsTo),
    facts,
    looksFor: (Array.isArray(r.looksFor) ? r.looksFor : []).map(s).filter(Boolean).slice(0, 6),
    canBring: (Array.isArray(r.canBring) ? r.canBring : []).map(s).filter(Boolean).slice(0, 6),
  };
}

function factLines(p: any): string {
  const r = p.research ?? {};
  return [
    profileLines(p),
    r.sells ? "Sells: " + r.sells + (r.sellsTo ? " (to " + r.sellsTo + ")" : "") : "",
    (r.looksFor ?? []).length ? "Looks for: " + r.looksFor.join("; ") : "",
    (r.canBring ?? []).length ? "Can bring: " + r.canBring.join("; ") : "",
    (r.facts ?? []).length ? "Facts (each with where it was read):\\n" + r.facts.map((f: any) => "- " + f.fact + " [" + f.url + "]").join("\\n") : "Facts: none found beyond the profile.",
  ].filter(Boolean).join("\\n");
}

/** The one person among the candidates good for BOTH sides, or null (the match LLM). */
function matchOne(ctx: any, reader: any, candidates: any[], wanted?: string): any {
  if (!candidates.length) return null;
  const m = complete(ctx, "match", MATCH_PROMPT, [
    "THE READER",
    factLines(reader),
    wanted ? "\\nWHAT THE READER ASKED FOR: " + wanted : "",
    "",
    "CANDIDATES",
    candidates.map((c: any, i: number) => "#" + i + "\\n" + factLines(c)).join("\\n\\n"),
  ].join("\\n"), MATCH_SCHEMA);
  const i = typeof m.pick === "number" ? m.pick : -1;
  if (i < 0 || i >= candidates.length) return null;
  return { person: candidates[i], index: i, forReader: s(m.forReader), forThem: s(m.forThem) };
}

/** Serve one fresh person of our lead search (lead-service), or null with the reason. */
function serveOne(ctx: any, serve: any): { lead: any } | { none: string; again?: boolean; final?: boolean } {
  const a = ctx.vendor.call("lead.serve", serve ?? {});
  if (!a.ok) throw new Error("lead.serve failed: " + String(a.data && a.data.error));
  const d: any = a.data;
  if (d.found !== true || !d.lead) {
    const reason = s(d.reason) || "nobody";
    return { none: reason, again: reason === "serve_timed_out" && d.final !== false, final: d.final === true };
  }
  return { lead: d.lead };
}

/** Does this campaign's brief ask for intros? Judged once per brief (Jev), kept in the Engine's storage. */
function briefAsksIntros(ctx: any, brief: string, question: string, now: string): boolean {
  if (!brief) return false;
  const key = briefKey(brief);
  let v: any = ctx.storage.get("briefs", key);
  if (v === null || v === undefined) {
    const j = must(ctx, "jev.noul", { state: { brief }, questions: { asks: { instructions: question } } });
    const pr = j.probabilities?.asks;
    if (typeof pr !== "number") throw new Error("intro: Jev answered no probability on the brief");
    v = { asks: pr >= 0.5, probability: pr, at: now };
    ctx.storage.set("briefs", key, v);
  }
  return v.asks === true;
}
`;

// ---------------------------------------------------------------------------------------------------------------
// 1. The path (paid_client).
// ---------------------------------------------------------------------------------------------------------------

export function buildIntroPathSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** A path toward Paid client by intros (INTRO-BOARDY-1114): asks for the intro first email, records it, carries the conversation. */`,
    SHARED,
    `
const MATERIAL = ${JSON.stringify(INTRO_MATERIAL)};

function forward(answer: any): any {
  return { unmade: String(answer.unmade), ...(answer.decided === "done" || answer.decided === "idle" ? { decided: answer.decided } : {}), ...(answer.run && answer.run.again === true ? { again: true } : {}) };
}

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request;
  if (!R) return { unmade: "no_request" };
  const now = s(R.now);
  if (!now) throw new Error("intro path: the run states no clock (request.now)");
  const t: any = ctx.tactics ?? {};
  const question = s(t.briefQuestion);
  if (!question) throw new Error("intro path: the script states no briefQuestion (tactic): nothing is asked");
  const trigger = R.trigger && typeof R.trigger === "object" ? R.trigger : null;
  const asks = briefAsksIntros(ctx, s(R.brief), question, now);

  if (!asks) {
    // A campaign that asks for no intros: a proactive tick has nothing to do here (the next script is tried); a lead who
    // writes gets the one answer every lead gets, exactly as dy_answer_lead_pull asks it.
    if (!trigger) return null;
    ctx.ask({ units: {}, request: R, recordedBy: "sender" });
    const answer: any = ctx.get("message_sent");
    if (answer && typeof answer.unmade === "string") return forward(answer);
    return { content: { answered: answer.content } };
  }

  if (trigger) {
    // A Lead event: the next step of that person's intro conversation (the intro answerer only reads this material).
    ctx.ask({ units: { [MATERIAL]: { content: { step: "answer" } } }, request: R, recordedBy: "sender" });
    const answer: any = ctx.get("message_sent");
    if (answer && typeof answer.unmade === "string") return forward(answer);
    return { content: { answered: answer.content } };
  }

  // A proactive tick: ONE intro first email (an intro script of the Email sent Engine, the Rating picks which).
  ctx.ask({ units: { [MATERIAL]: { content: { step: "first_email" } } }, request: R, recordedBy: "instantly" });
  const sent: any = ctx.get("email_sent");
  if (sent && typeof sent.unmade === "string") return forward(sent);
  // Recorded where the conversation goes on (the Message sent Engine's notes): who was proposed to whom, and the hold.
  ctx.ask({ units: { [MATERIAL]: { content: { step: "record", sent: sent.content } } }, request: R, recordedBy: "sender" });
  const recorded: any = ctx.get("message_sent");
  return { content: { intro: sent.content, recorded: recorded && typeof recorded.unmade === "string" ? recorded.unmade : "recorded" } };
}
`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// 2. The first email (email_sent): lead to lead, open, client to lead.
// ---------------------------------------------------------------------------------------------------------------

export function buildIntroFirstEmailSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** The intro first email (INTRO-BOARDY-1114): one reader, researched, offered ONE intro good for both, or asked who they want to meet. */`,
    SHARED,
    `
const MATERIAL = ${JSON.stringify(INTRO_MATERIAL)};
const FIRST_EMAIL_PROMPT = ${JSON.stringify(FIRST_EMAIL_PROMPT)};
const FIRST_EMAIL_KIND = ${JSON.stringify(FIRST_EMAIL_KIND)};
const FIRST_EMAIL_SCHEMA = ${JSON.stringify(FIRST_EMAIL_SCHEMA)};
const KINDS = ["lead_to_lead", "open", "client_to_lead"];

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  // Only the intro path hands this material: any other campaign's run never holds it.
  ctx.get("intro_requested");
  const now = s(R.now);
  if (!now) throw new Error("intro: the run states no clock (request.now)");
  const kind = s(t.intro);
  if (KINDS.indexOf(kind) < 0) throw new Error("intro: the script states no known tactic intro: " + JSON.stringify(t.intro));
  const persona = t.persona ?? {};
  if (!s(persona.name) || !s(persona.says)) throw new Error("intro: the script states no persona {name, says} (tactic)");
  const brandId = Array.isArray(R.brandIds) && R.brandIds[0] ? String(R.brandIds[0]) : s(R.brandId);
  const campaignId = s(R.campaignId);
  if (!brandId || !campaignId) throw new Error("intro: the run names no brand or campaign");
  const testRecipient = emailOf(R.testRecipient);
  const dryRun = R.dryRun === true;

  const brand = (must(ctx, "brand.profile", { params: { id: brandId } }).brand) || {};
  const brandName = s(brand.name);
  // Client to lead: the brand's person is its stated sales rep (first name and role only, never an invented name).
  const rep = kind === "client_to_lead" ? tolerated(ctx, "brand.sales_rep", { params: { brandId } }) : null;
  if (kind === "client_to_lead" && !s(rep?.salesRepFirstName)) return { unmade: "no_brand_person: the brand states no sales rep to introduce" };

  // 1. THE READER: one person of our lead search.
  const served = serveOne(ctx, t.serve);
  if ("none" in served) {
    if (served.none === "audience_exhausted" || served.final) return { unmade: served.none };
    return served.again ? { unmade: served.none, again: true } : { unmade: served.none };
  }
  const reader: any = personOf(served.lead);
  if (!reader.email) throw new Error("intro: the served person carries no email");
  // Someone the brand already talks with is never written to as a stranger: their next reader is served.
  const th = ctx.vendor.call("crm.person.thread", { query: { brandId, personKey: "email:" + reader.email } });
  if (!th.ok && th.data.status !== 404) throw new Error("crm.person.thread failed: " + String(th.data.error));
  const talked = th.ok && Array.isArray(th.data.items) ? th.data.items.filter((i: any) => i && i.kind === "message").length : 0;
  if (talked > 0) return { unmade: "already_in_conversation: the brand already exchanged " + talked + " message(s) with them", again: true };
  reader.research = research(ctx, reader, brandId, campaignId);

  // 2. THE OTHER PERSON.
  const poolDays = Number.isInteger(t.poolDays) ? t.poolDays : 60;
  const poolMax = Number.isInteger(t.poolMax) ? t.poolMax : 40;
  const fresh = (p: any) => Date.parse(now) - Date.parse(String(p.keptAt || now)) < poolDays * 86400000;
  let pool: any[] = (ctx.storage.get("intro_pool", "people") ?? []).filter(fresh);
  const keepPool = () => { if (!testRecipient && !dryRun) ctx.storage.set("intro_pool", "people", pool.slice(0, poolMax)); };
  let other: any = null;
  let howFound = "";
  if (kind === "lead_to_lead") {
    const sameCompany = (p: any) => (p.company?.domain && p.company.domain === reader.company.domain) || p.email === reader.email;
    const candidates = pool.filter((p) => !sameCompany(p));
    const want = Number.isInteger(t.freshCandidates) ? t.freshCandidates : 2;
    for (let i = 0; i < want; i++) {
      const c = serveOne(ctx, t.serve);
      if ("none" in c) break;
      const p: any = personOf(c.lead);
      if (!p.email || sameCompany(p)) continue;
      p.research = research(ctx, p, brandId, campaignId);
      p.keptAt = now;
      candidates.push(p);
      pool = [p].concat(pool.filter((x) => x.email !== p.email));
    }
    other = matchOne(ctx, reader, candidates);
    if (!other) {
      // No fit for both: nobody hears anybody's name. The reader waits among the candidates for a better match.
      reader.keptAt = now;
      pool = [reader].concat(pool.filter((x) => x.email !== reader.email));
      keepPool();
      return { unmade: "no_fit: no candidate is good for both sides (" + candidates.length + " looked at)", again: true };
    }
    howFound = "Both of them are people our lead search found (Apollo-sourced prospects our AI researched). Nobody recommended or pointed us to either of them.";
  } else if (kind === "client_to_lead") {
    const fields = must(ctx, "brand.extract_fields", { body: { fields: [
      { key: "leadership", description: "Company leadership and key team members, with their roles" },
      { key: "companyOverview", description: "A comprehensive overview of the company" },
      { key: "socialProof", description: "Clients named, case studies, results with figures" },
    ], offerId: s(R.offerId) || undefined } }).fields ?? {};
    const value = (k: string) => { const v = fields[k]?.value; return typeof v === "string" ? v : v ? JSON.stringify(v) : ""; };
    const repName = s(rep?.salesRepFirstName);
    const brandPerson = {
      leadId: null,
      email: null,
      firstName: repName.split(" ")[0] || "",
      lastName: repName.split(" ").slice(1).join(" "),
      title: s(rep?.salesRepRole),
      headline: "",
      linkedinUrl: "",
      city: "",
      country: "",
      company: { name: brandName, domain: hostOf(brand.url), website: s(brand.url), description: value("companyOverview") },
      research: {
        sells: value("companyOverview"),
        sellsTo: "",
        facts: [value("leadership"), value("socialProof")].filter(Boolean).map((f) => ({ fact: f.slice(0, 600), url: s(brand.url) })),
        looksFor: [],
        canBring: [],
      },
    };
    other = matchOne(ctx, reader, [brandPerson]);
    if (!other) {
      reader.keptAt = now;
      pool = [reader].concat(pool.filter((x) => x.email !== reader.email));
      keepPool();
      return { unmade: "no_fit: the brand's person is not good for this reader", again: true };
    }
    howFound = "The reader is a person our lead search found (an Apollo-sourced prospect our AI researched); nobody recommended or pointed us to them. The other person is " + (brandName || "the brand") + "'s own " + (s(rep?.salesRepRole) || "team member") + ".";
  }

  // 3. THE EMAIL, in our voice, from the campaign brief.
  const voice = must(ctx, "voice.read", {});
  const system = [
    FIRST_EMAIL_PROMPT,
    FIRST_EMAIL_KIND[kind],
    whoYouAre(t),
    "OUR VOICE\\n" + String(voice.content ?? ""),
    s(R.brief) ? "THE CAMPAIGN'S BRIEF\\n" + s(R.brief) : "",
  ].filter(Boolean).join("\\n\\n");
  const message = [
    "TODAY: " + now.slice(0, 10),
    "",
    "THE READER",
    factLines(reader),
    other ? "\\nTHE OTHER PERSON\\n" + factLines(other.person) : "",
    other ? "\\nWHY THEY SHOULD MEET\\nFor the reader: " + other.forReader + "\\nFor the other person: " + other.forThem : "",
    howFound ? "\\nHOW WE FOUND THEM: " + howFound : "",
  ].filter((l) => l !== "").join("\\n");
  const d = complete(ctx, "writer", system, message, FIRST_EMAIL_SCHEMA);
  const subject = undash(d.subject);
  const body = undash(d.body);
  if (!subject || !body) throw new Error("intro: the writer returned no subject or body: " + JSON.stringify(d).slice(0, 300));
  const counterpart = other ? { leadId: other.person.leadId, email: other.person.email, name: nameOf(other.person), title: other.person.title, company: other.person.company?.name ?? "", domain: other.person.company?.domain ?? "", research: other.person.research, forReader: other.forReader, forThem: other.forThem } : null;
  const content = { kind, subject, body, reader: { leadId: reader.leadId, email: reader.email, name: nameOf(reader), firstName: reader.firstName, title: reader.title, company: reader.company.name, domain: reader.company.domain, research: reader.research }, counterpart, sentTo: testRecipient || reader.email };
  if (dryRun) return { content: { ...content, dryRun: true } };

  // 4. SENT (one email, our persona signs).
  const to = testRecipient || reader.email;
  const send = ctx.vendor.call("email.send", {
    body: {
      type: "broadcast",
      tag: s(t.sendTag) || "intro-email",
      to,
      ...(testRecipient ? {} : { leadId: reader.leadId }),
      subject,
      sequence: [{ step: 1, bodyHtml: toHtml(body), bodyText: body, daysSinceLastStep: 0 }],
      campaignId,
      recipientFirstName: reader.firstName,
      recipientLastName: reader.lastName,
      recipientCompany: reader.company.name,
      ...(s(t.signature) ? { signature: { text: s(t.signature) } } : {}),
      idempotencyKey: "intro:" + kind + ":" + (testRecipient ? to + ":" + now : reader.leadId || reader.email),
      metadata: { source: "intro", kind },
    },
  });
  if (!send.ok) {
    const dd: any = send.data ?? {};
    const code = s(dd.code) || s(dd.body?.code) || s(dd.body?.details?.code);
    if (code && Number(dd.status) === 409) return { unmade: code + ": " + String(dd.body?.error ?? dd.error ?? "").slice(0, 300), again: true };
    throw new Error("email.send failed (" + String(dd.status ?? "") + "): " + String(dd.error ?? "").slice(0, 300));
  }
  if (send.data?.success !== true) throw new Error("email.send answered without success: true");
  // The proposed person leaves the candidates: one pending intro per person.
  if (counterpart?.email) pool = pool.filter((p) => p.email !== counterpart.email);
  keepPool();
  return { content, ...(reader.leadId && !testRecipient ? { subject: { service: "lead-service", id: reader.leadId } } : {}) };
}
`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// 3. The intro conversation (message_sent).
// ---------------------------------------------------------------------------------------------------------------

export function buildIntroAnswerSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** The intro conversation (INTRO-BOARDY-1114): double opt-in, the introduction, the reader's own goal; a decline is kept forever. */`,
    SHARED,
    `
const MATERIAL = ${JSON.stringify(INTRO_MATERIAL)};
const INTRO_GAME = ${JSON.stringify(INTRO_GAME)};
const ANSWER_ACTIONS = ${JSON.stringify(ANSWER_ACTIONS)};
const PROPOSE_PROMPT = ${JSON.stringify(PROPOSE_PROMPT)};
const PROPOSE_SCHEMA = ${JSON.stringify(PROPOSE_SCHEMA)};
function answerSchema(actions: string[]): any {
  const text = { type: "string" };
  return { type: "object", additionalProperties: false, required: ["action", "replyText", "readerText", "otherSubject", "otherText", "introText", "followText", "wanted", "nextFollowUpAt", "why"],
    properties: { action: { type: "string", enum: actions.slice() }, replyText: text, readerText: text, otherSubject: text, otherText: text, introText: text, followText: text, wanted: text, nextFollowUpAt: text, why: text } };
}

const PEOPLE = "intro_people";
const DAY = 86400000;

/** Hold the lead for this campaign: no other campaign of the brand answers a lead of an intro thread (answering_leads). */
function hold(ctx: any, leadKey: string, campaignId: string, now: string, days: number): void {
  if (!leadKey) return;
  ctx.storage.set("answering_leads", leadKey, { campaignId, at: now, holdUntil: new Date(Date.parse(now) + days * DAY).toISOString(), conversation: "intro" });
}

function record(ctx: any, R: any, sent: any, now: string, days: number): ScriptResult {
  const campaignId = s(R.campaignId);
  const reader = sent?.reader ?? {};
  const email = emailOf(reader.email);
  if (!email) throw new Error("intro record: the first email names no reader address");
  const prior = ctx.storage.get(PEOPLE, email);
  ctx.storage.set(PEOPLE, email, {
    role: "reader",
    kind: s(sent.kind),
    campaignId,
    leadId: s(reader.leadId) || null,
    name: s(reader.name),
    firstName: s(reader.firstName),
    company: s(reader.company),
    research: reader.research ?? null,
    pending: sent.counterpart ? { ...sent.counterpart, state: "proposed", proposedAt: now } : null,
    state: sent.counterpart ? "proposed" : "asked_who",
    declined: prior?.declined === true,
    introductions: Number(prior?.introductions ?? 0),
    firstEmail: { subject: s(sent.subject), at: now },
  });
  hold(ctx, s(reader.leadId) || email, campaignId, now, days);
  return { unmade: "recorded: the intro to " + email + " is kept for its conversation", decided: "done" };
}

/** The person's email thread: instantly's conversation (every email, its Message-ID and who was on it) + the Unibox. */
function readThread(ctx: any, brandId: string, email: string): any {
  const th = ctx.vendor.call("crm.person.thread", { query: { brandId, personKey: "email:" + email }, pollWhile: { field: "factFeed.settled", equals: false, intervalSeconds: 10, timeoutSeconds: 180, throwWhenTimedOut: true } });
  if (!th.ok && th.data.status !== 404) throw new Error("crm.person.thread failed: " + String(th.data.error));
  const items = th.ok && Array.isArray(th.data.items) ? th.data.items : [];
  const conv = ctx.vendor.call("instantly.conversation", { query: { email } });
  const convo = conv.ok && conv.data.conversation && typeof conv.data.conversation === "object" ? conv.data.conversation : {};
  const mails = (Array.isArray(convo.messages) ? convo.messages : []).map((m: any) => ({ at: String(m.at || ""), direction: m.direction, subject: s(m.subject), text: String(m.text || ""), messageId: s(m.messageId) }));
  const seen: any = {};
  mails.forEach((m: any) => { seen[m.direction + ":" + m.at.slice(0, 16)] = true; });
  const others = items.filter((i: any) => i && i.kind === "message" && !(i.channel === "email" && seen[i.direction + ":" + String(i.at || "").slice(0, 16)]))
    .map((i: any) => ({ at: String(i.at || ""), direction: i.direction, subject: s(i.subject), text: String(i.text || ""), messageId: s(i.ref && i.ref.messageId) || s(i.messageId), channel: i.channel }));
  const all = mails.concat(others).sort((a: any, b: any) => a.at.localeCompare(b.at));
  const lastInbound = all.filter((m: any) => m.direction === "inbound" && m.messageId).slice(-1)[0] ?? null;
  const threads = Array.isArray(convo.threads) ? convo.threads : [];
  return { all, lastInbound, threads };
}

function threadText(thread: any): string {
  return thread.all.slice(-30).map((m: any) => "[" + m.at + "] " + (m.direction === "inbound" ? "THEM" : "US") + (m.subject ? " (subject: " + m.subject + ")" : "") + ": " + m.text.slice(0, 2000)).join("\\n") || "(no message on record)";
}

/** Reply in the person's own thread (the mailbox they wrote to sends it), optionally with people in To / Cc. */
function replyIn(ctx: any, thread: any, email: string, text: string, key: string, extra?: Record<string, unknown>): void {
  const body_html = toHtml(text);
  let a: any;
  if (thread.lastInbound) a = ctx.vendor.call("instantly.reply.send", { body: { email, body_html, sent_by: "automation", in_reply_to: thread.lastInbound.messageId, ...(extra ?? {}) } });
  else if (thread.threads.length && s(thread.threads[0].campaignId)) a = ctx.vendor.call("instantly.reply.send", { body: { campaign_id: thread.threads[0].campaignId, email, body_html, sent_by: "automation", ...(extra ?? {}) } });
  else throw new Error("intro: no email thread to answer " + email + " in");
  if (!a.ok) throw new Error("instantly.reply.send failed (" + String(a.data.status ?? "") + "): " + String(a.data.error ?? "").slice(0, 300) + " [" + key + "]");
}

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  const material: any = ctx.get("intro_requested");
  const step = s(material?.content?.step);
  const now = s(R.now);
  if (!now) throw new Error("intro answer: the run states no clock (request.now)");
  const days = Number.isInteger(t.holdDays) ? t.holdDays : 60;
  if (step === "record") return record(ctx, R, material.content.sent, now, days);
  if (step !== "answer") throw new Error("intro answer: unknown step " + JSON.stringify(step));

  const trigger = R.trigger && typeof R.trigger === "object" ? R.trigger : null;
  if (!trigger) return { unmade: "no_occurrence", decided: "idle" };
  const brandId = Array.isArray(R.brandIds) && R.brandIds[0] ? String(R.brandIds[0]) : s(R.brandId);
  const campaignId = s(R.campaignId);
  if (!brandId || !campaignId) throw new Error("intro answer: the run names no brand or campaign");
  const email = emailOf(trigger.person?.email);
  const me: any = email ? ctx.storage.get(PEOPLE, email) : null;
  // Only a person of an intro thread of THIS campaign: anyone else is not this conversation's.
  if (!me || (me.campaignId && me.campaignId !== campaignId)) return { unmade: "not_an_intro_thread: nothing of this campaign's intros names " + (email || "this person"), decided: "idle" };

  // WHO: claimed on this campaign (lead-service judges who may be answered).
  const named = { email, phone: s(trigger.person?.phone) || null, leadId: s(trigger.leadId) || null };
  const claim = must(ctx, "lead.followup.claim", { params: { campaignId }, body: { person: named, relationships: s(t.relationships) || "pure_prospect" } });
  if (!claim.found) {
    const refused = ((claim.relationships && claim.relationships.refused) || [])[0];
    if (refused) return { unmade: "person_not_admitted: " + String(refused.reason || refused.code || "refused") };
    return { unmade: "nobody_due: " + String(claim.reason || ""), decided: "idle" };
  }
  const row = claim.followup;
  const close = (reason: string) => must(ctx, "lead.followup.record", { params: { id: row.id }, body: { kind: "stopped", reason } });
  const setDate = (body: any) => must(ctx, "lead.followup_date.set", { params: { id: row.id }, query: { brandId }, body });
  hold(ctx, s(row.leadId) || named.leadId || email, campaignId, now, days);

  // READ: this thread, the other side's state, the brand and its offer (the price lives there, said only after a yes).
  const thread = readThread(ctx, brandId, email);
  const brand = (must(ctx, "brand.profile", { params: { id: brandId } }).brand) || {};
  const offerId = s(R.offerId);
  const answers = offerId ? must(ctx, "brand.offer.answers", { params: { brandId, offerId } }) : {};
  const economics = offerId ? must(ctx, "brand.offer.economics", { params: { offerId } }) : {};
  const offerLines = (Array.isArray(answers.answers) ? answers.answers : [])
    .filter((a: any) => !/^\\s*PLACEHOLDER/.test(String(a.answer || "")))
    .map((a: any) => "- " + a.question + " " + String(a.answer || ""));
  // The offer's own facts the client confirmed (what it costs, how it starts), as the answerer reads them.
  const fields = offerId ? must(ctx, "brand.offer.fields", { params: { brandId, offerId } }) : { fields: {} };
  const f: any = fields.fields || {};
  Object.keys(f).forEach((k) => {
    const v = f[k];
    if (v && v.provenance === "confirmed" && v.value !== null && v.value !== undefined) offerLines.push("- " + k + ": " + (typeof v.value === "string" ? v.value : JSON.stringify(v.value)));
  });
  if (s(economics.name)) offerLines.unshift("- Offer: " + economics.name);
  if (s(brand.url)) offerLines.push("- The brand's site (where they sign up): " + s(brand.url));
  if (s(economics.bookingUrl)) offerLines.push("- Booking link: " + economics.bookingUrl);
  const voice = must(ctx, "voice.read", {});
  const reader: any = me.role === "reader" ? me : me.reader ? ctx.storage.get(PEOPLE, emailOf(me.reader.email)) ?? me.reader : null;

  const open: string[] = ["reply", "later", "stop", "escalate"];
  if (me.role === "reader") {
    if (me.pending && me.pending.state === "proposed") open.unshift("ask_other");
    // One intro at a time: a new one once nothing is pending (none yet, or the last one introduced, declined or refused).
    const pendingOpen = me.pending && ["proposed", "asked"].indexOf(String(me.pending.state)) >= 0;
    if (!me.declined && !pendingOpen) open.unshift("find");
    if (!me.declined) open.push("decline_intros");
  } else if (me.role === "counterpart" && me.state === "asked") {
    open.unshift("introduce", "counterpart_declined");
  }
  const state = {
    you_are_writing_to: me.role === "reader" ? "THE READER (the person we offered an intro to)" : "THE OTHER PERSON (we asked them whether they want to meet the reader)",
    stage: me.state,
    declinedIntros: me.declined === true,
    introductionsMade: Number(me.introductions ?? 0),
    pendingIntro: me.role === "reader" ? me.pending ?? null : { reader: reader ? { name: reader.name, company: reader.company } : null },
  };
  const system = [
    INTRO_GAME,
    whoYouAre(t),
    "OUR VOICE\\n" + String(voice.content ?? ""),
    s(R.brief) ? "THE CAMPAIGN'S BRIEF\\n" + s(R.brief) : "",
  ].filter(Boolean).join("\\n\\n");
  const message = [
    "NOW: " + now,
    "ACTIONS OPEN TO YOU: " + open.join(", "),
    "",
    "THE STATE\\n" + JSON.stringify(state, null, 2),
    "",
    me.role === "reader" ? "THE READER (you are writing to them)\\nName: " + me.name + "\\nCompany: " + me.company + (me.research ? "\\n" + JSON.stringify(me.research) : "") : "",
    me.role === "reader" && me.pending ? "THE OTHER PERSON PROPOSED\\n" + JSON.stringify(me.pending) : "",
    me.role === "counterpart" && reader ? "THE READER (who wants to meet them)\\nName: " + reader.name + "\\nCompany: " + reader.company + (reader.research ? "\\n" + JSON.stringify(reader.research) : "") : "",
    me.role === "counterpart" ? "THE OTHER PERSON (you are writing to them)\\nName: " + me.name + "\\nCompany: " + me.company + (me.research ? "\\n" + JSON.stringify(me.research) : "") : "",
    "",
    "THE OFFER (" + s(brand.name) + ")\\n" + (offerLines.join("\\n") || "(no offer facts)"),
    "",
    "THE THREAD\\n" + threadText(thread),
  ].filter((l) => l !== "").join("\\n");
  const d = complete(ctx, "writer", system, message, answerSchema(open));
  const action = s(d.action);
  if (open.indexOf(action) < 0) throw new Error("intro answer: the writer chose an action not open to it: " + JSON.stringify(d.action));
  const next = s(d.nextFollowUpAt) && Number.isFinite(Date.parse(d.nextFollowUpAt)) && Date.parse(d.nextFollowUpAt) > Date.parse(now) ? new Date(Date.parse(d.nextFollowUpAt)).toISOString() : new Date(Date.parse(now) + 7 * DAY).toISOString();
  const why = s(d.why).slice(0, 400);
  const keyBase = "intro:" + (s(trigger.eventId) || row.id);
  const text = (k: string) => { const v = undash(d[k]); if (!v) throw new Error("intro answer: " + action + " with an empty " + k); return v; };
  const save = (who: string, v: any) => ctx.storage.set(PEOPLE, who, v);

  if (action === "later") {
    setDate({ nextFollowupAt: next, reason: why || "later" });
    close("intro_later");
    return { unmade: "later: " + why, decided: "done" };
  }
  if (action === "stop") {
    setDate({ stop: { reason: why || "asked to stop" } });
    close("intro_stopped");
    save(email, { ...me, declined: true, state: "stopped" });
    return { unmade: "stop: " + why, decided: "done" };
  }
  if (action === "escalate") {
    setDate({ nextFollowupAt: next, reason: "Escalated: " + why });
    close("intro_escalated");
    return { unmade: "escalate: " + why, decided: "done" };
  }

  if (action === "find") {
    // Our lead search: fresh people, researched, the one good for both sides (or none), then ONE proposal.
    const wanted = s(d.wanted);
    const candidates: any[] = [];
    const want = Number.isInteger(t.freshCandidates) ? t.freshCandidates : 3;
    for (let i = 0; i < want; i++) {
      const c = serveOne(ctx, {});
      if ("none" in c) break;
      const p: any = personOf(c.lead);
      if (!p.email || p.email === email) continue;
      p.research = research(ctx, p, brandId, campaignId);
      candidates.push(p);
    }
    const meAsReader = { firstName: me.firstName, lastName: "", title: "", company: { name: me.company }, research: me.research ?? {} };
    const m = matchOne(ctx, meAsReader, candidates, wanted);
    const p = complete(ctx, "writer", [PROPOSE_PROMPT, whoYouAre(t), "OUR VOICE\\n" + String(voice.content ?? ""), s(R.brief) ? "THE CAMPAIGN'S BRIEF\\n" + s(R.brief) : ""].filter(Boolean).join("\\n\\n"), [
      "NOW: " + now,
      "THE STATE\\n" + JSON.stringify(state, null, 2),
      "THE OFFER (" + s(brand.name) + ")\\n" + (offerLines.join("\\n") || "(no offer facts)"),
      "WHAT THEY WANT: " + wanted,
      "THE READER\\n" + me.name + ", " + me.company,
      m ? "THE ONE WHO FITS\\n" + factLines(m.person) + "\\nFor the reader: " + m.forReader + "\\nFor them: " + m.forThem : "NOBODY FITS (" + candidates.length + " people looked at)",
      "THE THREAD\\n" + threadText(thread),
    ].join("\\n\\n"), PROPOSE_SCHEMA);
    replyIn(ctx, thread, email, undash(p.replyText), keyBase + ":propose");
    save(email, { ...me, state: m ? "proposed" : "asked_who", pending: m ? { leadId: m.person.leadId, email: m.person.email, name: nameOf(m.person), title: m.person.title, company: m.person.company?.name ?? "", domain: m.person.company?.domain ?? "", research: m.person.research, forReader: m.forReader, forThem: m.forThem, state: "proposed", proposedAt: now } : null });
    setDate({ nextFollowupAt: next, reason: why || "proposed an intro", sent: { channel: "email" } });
    close("intro_proposed");
    return { content: { action, proposed: m ? nameOf(m.person) : null, looked: candidates.length } };
  }

  if (action === "ask_other") {
    const other = me.pending;
    const otherEmail = emailOf(other?.email);
    if (!otherEmail) throw new Error("intro answer: the proposed person carries no email to ask them by");
    replyIn(ctx, thread, email, text("replyText"), keyBase + ":thanks");
    const ask = ctx.vendor.call("email.send", { body: { type: "broadcast", tag: "intro-email", to: otherEmail, ...(other.leadId ? { leadId: other.leadId } : {}), subject: text("otherSubject"), sequence: [{ step: 1, bodyHtml: toHtml(text("otherText")), bodyText: text("otherText"), daysSinceLastStep: 0 }], campaignId, ...(s(t.signature) ? { signature: { text: s(t.signature) } } : {}), idempotencyKey: "intro-ask:" + otherEmail + ":" + email, metadata: { source: "intro", kind: "double_opt_in" } } });
    if (!ask.ok) {
      const code = s(ask.data?.code) || s(ask.data?.body?.code);
      if (!(code && Number(ask.data?.status) === 409)) throw new Error("email.send (double opt-in) failed: " + String(ask.data?.error ?? "").slice(0, 300));
      save(email, { ...me, pending: { ...other, state: "refused", refusal: code } });
    } else {
      save(email, { ...me, state: "asked_other", pending: { ...other, state: "asked", askedAt: now } });
      save(otherEmail, { role: "counterpart", campaignId, leadId: other.leadId ?? null, name: other.name, firstName: String(other.name || "").split(" ")[0], company: other.company, research: other.research ?? null, state: "asked", reader: { email, name: me.name, company: me.company }, askedAt: now });
      hold(ctx, s(other.leadId) || otherEmail, campaignId, now, days);
    }
    setDate({ nextFollowupAt: next, reason: why || "asked the other person", sent: { channel: "email" } });
    close("intro_asked_other");
    return { content: { action, asked: otherEmail, sent: ask.ok } };
  }

  if (action === "introduce" || action === "counterpart_declined") {
    const readerEmail = emailOf(me.reader?.email);
    const r: any = readerEmail ? ctx.storage.get(PEOPLE, readerEmail) : null;
    if (!readerEmail || !r) throw new Error("intro answer: the reader of this intro is not on record");
    const readerThread = readThread(ctx, brandId, readerEmail);
    if (action === "counterpart_declined") {
      replyIn(ctx, thread, email, text("replyText"), keyBase + ":thanks");
      replyIn(ctx, readerThread, readerEmail, text("readerText"), keyBase + ":reader");
      save(email, { ...me, state: "declined" });
      save(readerEmail, { ...r, state: "asked_who", pending: null });
      setDate({ nextFollowupAt: next, reason: why || "declined the intro", sent: { channel: "email" } });
      close("intro_counterpart_declined");
      return { content: { action, reader: readerEmail } };
    }
    // Both said yes: ONE email to both (the reader in To, the other person in copy), in the reader's thread.
    replyIn(ctx, readerThread, readerEmail, text("introText"), keyBase + ":introduce", { to: [readerEmail], cc: [email] });
    // Right after it, to the reader alone, when the writer has something for them (the brief says what and when).
    const follow = undash(d.followText);
    if (follow) replyIn(ctx, readerThread, readerEmail, follow, keyBase + ":follow", { to: [readerEmail] });
    save(email, { ...me, state: "introduced", introducedAt: now });
    save(readerEmail, { ...r, state: "introduced", pending: r.pending ? { ...r.pending, state: "introduced" } : null, introductions: Number(r.introductions ?? 0) + 1 });
    setDate({ nextFollowupAt: next, reason: why || "introduced", sent: { channel: "email" } });
    close("intro_introduced");
    return { content: { action, reader: readerEmail, other: email, introductions: Number(r.introductions ?? 0) + 1, followed: !!follow } };
  }

  if (action === "decline_intros") {
    replyIn(ctx, thread, email, text("replyText"), keyBase + ":decline");
    // Never a new intro again, even when asked (kept for every later look).
    save(email, { ...me, declined: true, declinedAt: now });
    setDate({ nextFollowupAt: next, reason: why || "declined intros", sent: { channel: "email" } });
    close("intro_declined");
    return { content: { action } };
  }

  // reply: whatever they wrote (a question, an answer, a yes to what we offered).
  replyIn(ctx, thread, email, text("replyText"), keyBase + ":reply");
  save(email, { ...me, lastReplyAt: now });
  setDate({ nextFollowupAt: next, reason: why || "answered", sent: { channel: "email" } });
  close("intro_replied");
  return { content: { action } };
}
`,
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// 4. The answerer respects an intro hold (an UPGRADE of every `message_sent/dy_answer_lead*` dynasty).
// ---------------------------------------------------------------------------------------------------------------

/**
 * A campaign never takes another campaign's work in progress (framework §12). The answerer already steps aside for
 * 30 minutes after another campaign's last answer (`answering_leads`); an intro conversation is longer than that (the
 * other person answers days later), so the intro campaign states a `holdUntil` on the lead and the answerer steps
 * aside until then. A note with no `holdUntil` (every note written today) reads exactly as before.
 */
export const ANSWERER_OWNER_CHECK =
  "    if (owner && owner.campaignId !== campaignId && Date.parse(now) - Date.parse(String(owner.at)) < 30 * 60000) {\n";
export const ANSWERER_OWNER_CHECK_WITH_HOLD =
  "    if (owner && owner.campaignId !== campaignId && (Date.parse(now) - Date.parse(String(owner.at)) < 30 * 60000 || (owner.holdUntil && Date.parse(String(owner.holdUntil)) > Date.parse(now)))) {\n";

export function answererRespectsHold(stored: string): string {
  if (stored.includes("owner.holdUntil")) throw new Error("answerer upgrade: the stored code already reads a hold");
  const n = stored.split(ANSWERER_OWNER_CHECK).length - 1;
  if (n !== 1) throw new Error(`answerer upgrade: the owner check found ${n} times, want exactly 1: read the stored code again`);
  return stored.replace(ANSWERER_OWNER_CHECK, () => ANSWERER_OWNER_CHECK_WITH_HOLD);
}
