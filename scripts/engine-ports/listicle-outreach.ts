/**
 * LISTICLE-OUTREACH-1110 (owner 2026-11-09 « go » on the backlinks Engine; the earning half of BACKLINK-ENGINE-1109).
 *
 * Two scripts, one generator file:
 *
 * 1. `backlink_earned/dy_listicle_outreach`: a HOW of the Backlink Engine (tactic `how`). One run asks ONE author of a
 *    "best X companies" list page that names the brand's competitors but not the brand to add the brand:
 *      scraping-service   the brand's link gap vs the competitors the tactics state (once a day: idempotency key per day),
 *      scraping-service   per linking site not looked at yet: its URLs (`/map`), then the one list page the reader picks,
 *      the reader LLM     reads that page: is it a list of companies, which competitors it names, does it name the brand,
 *                         who wrote it (only a name the page states),
 *      apollo-service     the author's work email (treg; verified before it is served; a miss costs nothing),
 *      the writer LLM     the pitch, in our voice, from the campaign's brief (the figure it offers is the brief's data
 *                         study: nothing invented, never a promised result),
 *      Engine Email sent  sends it: `ctx.ask` hands the found address + the written email, so the email Engine's script
 *                         that reads both (`dy_send_written`) sends it on a CHILD run (its spend + Unit there).
 *    Every site looked at is kept in the Engine's storage (`sites`, per org) with what was found, so no site is looked at
 *    twice and no author is pitched twice. The brief decides whether this campaign asks for this work at all: a brief
 *    that does not (Jev, judged once per brief, kept) = nothing done, nothing spent (the Backlink Engine's other script
 *    counts the links; a campaign that asks only for that never pitches anyone).
 *    The run makes no Backlink Unit itself (scraping-service declares one when a link appears live, whatever earned it):
 *    a pitched author = made + tactic `support` (its spend reads link outreach), recorded_by scraping (never declared here).
 *    Test: `request.testRecipient` sends the pitch to that address instead of the author and keeps nothing in storage.
 *
 * 2. `email_sent/dy_send_written`: sends ONE email already written (Unit `message_written` {subject, bodyHtml}) to ONE
 *    found person (Unit `email_found` {email, firstName?, lastName?, company?}), exactly as written, through
 *    email-gateway's broadcast send, keyed on the asker's `request.idempotencyKey`. Reached only by an ask handing both
 *    (a campaign run holds neither). A refusal the sender names (409) = unmade with its code; recorded_by email-gateway.
 */
import { PORT_HEAD } from "./port-kit.js";

export const LISTICLE_OUTREACH = {
  outcome: "backlink_earned",
  dynasty: "dy_listicle_outreach",
  tactics: {
    recorded_by: "scraping",
    asks: ["email_sent"],
    how: "asks the author of a best-of list page that names the brand's competitors but not the brand to add the brand, one email per page",
    competitors: ["belkins.io", "martal.ca", "gojiberry.ai", "explee.com"],
    minCompetitors: 1,
    minDomainRank: 0,
    maxSpamScore: 5,
    sitesPerRun: 3,
    pageSearch: "best",
    readerLlm: { provider: "anthropic", model: "sonnet" },
    llm: { provider: "anthropic", model: "opus" },
    finder: "treg",
    support: {
      kind: "link_outreach",
      reason: "Listicle outreach: one email asking a list author to add the brand; the Backlink Unit is declared later by scraping-service when the link is live",
    },
  },
  description:
    "Finds best-of list pages that name the brand's competitors but not the brand, finds each page's author and their work email, and asks the author by email to add the brand, one email per page.",
} as const;

export const SEND_WRITTEN = {
  outcome: "email_sent",
  dynasty: "dy_send_written",
  tactics: { recorded_by: "email-gateway", sendTag: "written-email" },
  description: "Sends one email another script already wrote to one person whose address another script found, exactly as written.",
} as const;

/** What the reader returns about one page (strict: Anthropic needs every property required). */
export const PAGE_READ_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["isCompanyList", "title", "competitorsNamed", "namesBrand", "authorFirstName", "authorLastName", "authorRole", "listTopic"],
  properties: {
    isCompanyList: { type: "boolean" },
    title: { type: "string" },
    competitorsNamed: { type: "array", items: { type: "string" } },
    namesBrand: { type: "boolean" },
    authorFirstName: { type: "string" },
    authorLastName: { type: "string" },
    authorRole: { type: "string" },
    listTopic: { type: "string" },
  },
} as const;

export const PAGE_PICK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: { url: { type: "string" } },
} as const;

export const PITCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "body"],
  properties: { subject: { type: "string" }, body: { type: "string" } },
} as const;

export const PAGE_PICK_PROMPT = [
  "You pick, among the URLs of one website, the ONE page most likely to be a ranked or curated list of companies (\"best X companies\", \"top X agencies\", \"X alternatives\") in the field of the competitors named in the message.",
  "Pick only a URL from the list, copied exactly. When none looks like such a list, answer an empty string.",
  "Answer as JSON: {\"url\": \"...\"}.",
].join("\n");

export const PAGE_READ_PROMPT = [
  "You read one web page and say what it is, from its words only.",
  "isCompanyList: true only when the page is a list or ranking of companies or services a reader could hire or buy from.",
  "competitorsNamed: the competitors from the message that the page names (by name or domain), as the message spells them.",
  "namesBrand: true when the page names the brand from the message (by name or domain).",
  "authorFirstName / authorLastName / authorRole: the person the page states wrote or updated it (a byline, an author box). Never a company, never a guess: empty strings when the page states no person.",
  "listTopic: what the list ranks, in a few words (e.g. \"lead generation companies\").",
  "title: the page's title.",
].join("\n");

export const PITCH_PROMPT = [
  "You write ONE short email to the author of a list article, asking them to add the brand to their list.",
  "The campaign brief below says who the brand is and the figure it offers: a figure from its own data study that nobody else publishes, with its link. Use only facts from the brief and the brand facts, never an invented figure.",
  "Open on their article by its title, in one sentence. Then the one figure from the study and why it fits their readers. Then the ask: add the brand to the list, in one sentence.",
  "Never promise them traffic, rankings or any result. Never offer money or a link exchange. Describe the brand only with the words the brief uses for it.",
  "Short sentences, one idea each. 90 words at most. No dashes (no em dash, no en dash). No greeting line beyond their first name. Sign with the brand's name only.",
  "subject: a few plain words about their article. body: the email as plain text, paragraphs separated by one empty line.",
  "Answer as JSON: {\"subject\": \"...\", \"body\": \"...\"}.",
].join("\n");

export const BRIEF_ASKS_QUESTION =
  "The state is a campaign brief a client wrote. Does it ask the campaign to contact the authors of articles or list pages (best-of lists, rankings, directories) to get the client's brand added or linked?";

export function buildListicleOutreachSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Listicle outreach: one author of a list page naming the brand's competitors but not the brand, asked by email to add it (LISTICLE-OUTREACH-1110). */`,
    `const BRIEF_HEADER = "";`,
    PORT_HEAD,
    `
const PAGE_PICK_PROMPT = ${JSON.stringify(PAGE_PICK_PROMPT)};
const PAGE_READ_PROMPT = ${JSON.stringify(PAGE_READ_PROMPT)};
const PITCH_PROMPT = ${JSON.stringify(PITCH_PROMPT)};
const BRIEF_ASKS_QUESTION = ${JSON.stringify(BRIEF_ASKS_QUESTION)};
const PAGE_PICK_SCHEMA = ${JSON.stringify(PAGE_PICK_SCHEMA)};
const PAGE_READ_SCHEMA = ${JSON.stringify(PAGE_READ_SCHEMA)};
const PITCH_SCHEMA = ${JSON.stringify(PITCH_SCHEMA)};
const PAGE_MAX_CHARS = 60000;

/** A short, stable key for a brief (no crypto in the sandbox: FNV-1a over the text). */
function briefKey(brief: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < brief.length; i++) { h ^= brief.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return "brief:" + h.toString(16) + ":" + brief.length;
}

const undash = (s: any) => String(s ?? "").replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(?=\\d)/g, "$1-").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ").trim();
const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\\./, ""); } catch (_e) { return ""; } };

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  const now = typeof R.now === "string" ? R.now : "";
  const day = now.slice(0, 10);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) throw new Error("listicle-outreach: the run states no clock (request.now): " + JSON.stringify(R.now));
  const competitors: string[] = Array.isArray(t.competitors) ? t.competitors.filter((c: any) => typeof c === "string" && c.trim()) : [];
  if (!competitors.length) throw new Error("listicle-outreach: the script's tactic competitors names no competitor");
  const reader = t.readerLlm ?? null;
  const writer = t.llm ?? null;
  if (!reader?.provider || !reader?.model || !writer?.provider || !writer?.model) throw new Error("listicle-outreach: the tactics state no readerLlm or llm");
  const brief = typeof R.brief === "string" ? R.brief.trim() : "";
  const testRecipient = typeof R.testRecipient === "string" && R.testRecipient.includes("@") ? R.testRecipient.trim().toLowerCase() : null;
  const brandId = Array.isArray(R.brandIds) && R.brandIds[0] ? R.brandIds[0] : ctx.brand;
  const campaignId = typeof R.campaignId === "string" ? R.campaignId : undefined;

  // 0. Does this campaign's brief ask for this work? Judged once per brief (kept), never a pitch on a brief that does not.
  if (!brief) return null;
  const bk = briefKey(brief);
  let asks: any = ctx.storage.get("briefs", bk);
  if (asks === null || asks === undefined) {
    const j = must(ctx, "jev.noul", { state: { brief }, questions: { asks: { instructions: BRIEF_ASKS_QUESTION } } });
    const pr = j.probabilities?.asks;
    if (typeof pr !== "number") throw new Error("listicle-outreach: Jev answered no probability on the brief");
    asks = { asks: pr >= 0.5, probability: pr, at: now };
    ctx.storage.set("briefs", bk, asks);
  }
  if (asks.asks !== true) return null;

  const brand = (must(ctx, "brand.profile", { params: { id: brandId } }).brand) || {};
  const brandName = String(brand.name ?? "").trim();
  const brandDomain = host(String(brand.url ?? "")) || String(brand.domain ?? "").replace(/^www\\./, "");
  if (!brandName || !brandDomain) throw new Error("listicle-outreach: the brand states no name or site");

  // 1. The link gap (once a day: a second run the same day reads the day's report back, no second spend).
  const gap = must(ctx, "scraping.backlinks.link_gap", {
    body: {
      idempotencyKey: "listicle-gap:" + day,
      competitors,
      minCompetitors: Number.isInteger(t.minCompetitors) ? t.minCompetitors : 1,
      minDomainRank: Number.isInteger(t.minDomainRank) ? t.minDomainRank : 0,
      maxSpamScore: Number.isInteger(t.maxSpamScore) ? t.maxSpamScore : 5,
    },
  });
  const sources = Array.isArray(gap.sources) ? gap.sources : [];
  const sitesPerRun = Number.isInteger(t.sitesPerRun) && t.sitesPerRun > 0 ? t.sitesPerRun : 3;
  const looked: any[] = [];
  const keep = (domain: string, v: any) => { looked.push({ domain, ...v }); if (!testRecipient) ctx.storage.set("sites", domain, { ...v, at: now }); };

  for (const s of sources) {
    if (looked.length >= sitesPerRun) break;
    const domain = String(s.domain ?? "").toLowerCase();
    if (!domain || ctx.storage.get("sites", domain)) continue;

    // 2. Its list page.
    const map = tolerated(ctx, "scraping.site.map", { body: { url: "https://" + domain, search: typeof t.pageSearch === "string" ? t.pageSearch : "best", limit: 100, brandIds: [brandId], campaignId } });
    const urls: string[] = Array.isArray(map.urls) ? map.urls.filter((u: any) => typeof u === "string").slice(0, 100) : [];
    if (!urls.length) { keep(domain, { status: "no_pages", why: map.ok === false ? String(map.error).slice(0, 200) : "the site lists no page" }); continue; }
    const pick = must(ctx, "llm.complete", {
      provider: reader.provider, model: reader.model, systemPrompt: PAGE_PICK_PROMPT, responseFormat: "json", responseSchema: PAGE_PICK_SCHEMA, brandTools: false,
      message: "Competitors: " + competitors.join(", ") + "\\n\\nURLs of " + domain + ":\\n" + urls.join("\\n"),
    });
    const pageUrl = String(pick.json?.url ?? "").trim();
    if (!pageUrl || !urls.includes(pageUrl)) { keep(domain, { status: "no_list_page" }); continue; }
    const page = tolerated(ctx, "scraping.page", { body: { url: pageUrl, enrich: false, brandIds: [brandId], campaignId } });
    const text = String(page.result?.rawMarkdown ?? "").slice(0, PAGE_MAX_CHARS);
    if (!text.trim()) { keep(domain, { status: "page_unreadable", page: pageUrl }); continue; }

    // 3. What the page is, and who wrote it.
    const read = must(ctx, "llm.complete", {
      provider: reader.provider, model: reader.model, systemPrompt: PAGE_READ_PROMPT, responseFormat: "json", responseSchema: PAGE_READ_SCHEMA, brandTools: false,
      message: "Brand: " + brandName + " (" + brandDomain + ")\\nCompetitors: " + competitors.join(", ") + "\\nPage: " + pageUrl + "\\n\\n" + text,
    }).json || {};
    if (read.isCompanyList !== true) { keep(domain, { status: "not_a_list", page: pageUrl }); continue; }
    if (read.namesBrand === true) { keep(domain, { status: "already_lists_brand", page: pageUrl }); continue; }
    const first = String(read.authorFirstName ?? "").trim();
    const last = String(read.authorLastName ?? "").trim();
    if (!first || !last) { keep(domain, { status: "no_author", page: pageUrl, title: read.title ?? null }); continue; }

    // 4. Their work email (verified; a miss costs nothing; still running = looked at again on a later run).
    const found = tolerated(ctx, "apollo.email.find", { body: { vendor: typeof t.finder === "string" ? t.finder : "treg", person: { firstName: first, lastName: last, domain } } });
    if (found.ok === false) throw new Error("apollo.email.find failed (" + String(found.status) + "): " + String(found.error).slice(0, 300));
    if (found.status === "pending") { looked.push({ domain, status: "email_pending", page: pageUrl }); continue; }
    if (found.found !== true || !found.email || found.emailVerification?.deliverable !== true) {
      keep(domain, { status: "no_email", page: pageUrl, author: first + " " + last, verdict: found.emailVerification?.verdict ?? found.status ?? null });
      continue;
    }

    // 5. The pitch, in our voice, from the brief.
    const voice = must(ctx, "voice.read", {});
    const draft = must(ctx, "llm.complete", {
      provider: writer.provider, model: writer.model, responseFormat: "json", responseSchema: PITCH_SCHEMA,
      systemPrompt: PITCH_PROMPT + "\\n\\nOUR VOICE\\n" + String(voice.content ?? "") + "\\n\\nCAMPAIGN BRIEF\\n" + brief,
      message: [
        "Author: " + first + " " + last + (read.authorRole ? ", " + read.authorRole : ""),
        "Article: " + String(read.title ?? "") + " (" + pageUrl + ")",
        "It ranks: " + String(read.listTopic ?? ""),
        "It names: " + (Array.isArray(read.competitorsNamed) ? read.competitorsNamed.join(", ") : ""),
        "Brand: " + brandName + " (" + brandDomain + ")",
      ].join("\\n"),
    }).json || {};
    const subject = undash(draft.subject);
    const body = undash(draft.body);
    if (!subject || !body) throw new Error("listicle-outreach: the writer returned no subject or body: " + JSON.stringify(draft).slice(0, 300));
    const bodyHtml = body.split(/\\n\\s*\\n/).map((p: string) => "<p>" + escapeHtml(p.trim()).replace(/\\n/g, "<br>") + "</p>").join("");

    // 6. Sent by the email Engine (a child run of this one).
    const to = testRecipient ?? String(found.email).toLowerCase();
    ctx.ask({
      units: {
        email_found: { content: { email: to, firstName: first, lastName: last, company: domain } },
        message_written: { content: { subject, bodyHtml, bodyText: body } },
      },
      request: { now, campaignId, idempotencyKey: "listicle-pitch:" + domain + (testRecipient ? ":test:" + now : "") },
      recordedBy: "email-gateway",
    });
    const sent: any = ctx.get("email_sent");
    if (sent && sent.unmade) {
      keep(domain, { status: "send_refused", page: pageUrl, author: first + " " + last, email: found.email, refusal: String(sent.unmade).slice(0, 300) });
      return { unmade: "send_refused: " + String(sent.unmade).slice(0, 300) };
    }
    const before = looked.slice();
    keep(domain, { status: "pitched", page: pageUrl, author: first + " " + last, email: found.email, subject });
    return { content: { pitched: { domain, page: pageUrl, title: read.title ?? null, author: first + " " + last, email: found.email, sentTo: to, subject, body }, looked: before } };
  }
  const pending = looked.some((l) => l.status === "email_pending");
  return { unmade: (pending ? "email_pending" : "no_listicle_left") + ": no author pitched this run (" + looked.length + " sites looked at, " + sources.length + " in the link gap)", ...(pending ? { again: true } : {}) };
}
`,
  ].join("\n");
}

export function buildSendWrittenSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Send written: one email another script wrote, sent as written to the person another script found (LISTICLE-OUTREACH-1110). */`,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  const person: any = ctx.get("email_found");
  const written: any = ctx.get("message_written");
  const p = person?.content ?? {};
  const w = written?.content ?? {};
  const to = typeof p.email === "string" ? p.email.trim() : "";
  if (!to.includes("@")) throw new Error("send-written: the found person carries no email");
  const subject = typeof w.subject === "string" ? w.subject.trim() : "";
  const bodyHtml = typeof w.bodyHtml === "string" ? w.bodyHtml.trim() : "";
  if (!subject || !bodyHtml) throw new Error("send-written: the written email carries no subject or bodyHtml");
  const key = typeof R.idempotencyKey === "string" && R.idempotencyKey ? R.idempotencyKey : "";
  if (!key) throw new Error("send-written: the asker states no idempotencyKey (a retried run must never send twice)");
  const step: Record<string, unknown> = { step: 1, bodyHtml, daysSinceLastStep: 0 };
  if (typeof w.bodyText === "string" && w.bodyText.trim()) step.bodyText = w.bodyText;
  const body: Record<string, unknown> = { type: "broadcast", tag: typeof t.sendTag === "string" ? t.sendTag : "written-email", to, subject, sequence: [step], idempotencyKey: key };
  if (typeof R.campaignId === "string" && R.campaignId) body.campaignId = R.campaignId;
  if (typeof p.firstName === "string" && p.firstName) body.recipientFirstName = p.firstName;
  if (typeof p.lastName === "string" && p.lastName) body.recipientLastName = p.lastName;
  if (typeof p.company === "string" && p.company) body.recipientCompany = p.company;
  const send: any = ctx.vendor.call("email.send", { body });
  if (!send.ok) {
    const d = send.data ?? {};
    const code = typeof d.code === "string" ? d.code : typeof d.body?.code === "string" ? d.body.code : typeof d.body?.details?.code === "string" ? d.body.details.code : null;
    if (code && Number(d.status) === 409) return { unmade: code + ": " + String(d.body?.error ?? d.error ?? "").slice(0, 300) };
    throw new Error("email.send failed (" + String(d.status ?? "") + "): " + String(d.error ?? "").slice(0, 300));
  }
  if (send.data?.success !== true) throw new Error("email.send answered without success: true");
  return { content: { to, subject, messageId: send.data.messageId ?? null, deduplicated: send.data.deduplicated === true } };
}
`,
  ].join("\n");
}
