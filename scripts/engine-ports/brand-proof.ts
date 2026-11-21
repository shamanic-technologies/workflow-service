/**
 * BRAND-PROOF-LOGOS-1121 (owner 2026-11-21: « Est-ce que tu pourrais créer un nouvel Outcome / Engine qui récupère
 * l'ensemble de ces informations as outcomes / engines / scripts ? Dispo génériquement pour tous nos clients. »): the
 * proof a brand shows on its site, as two Engines of their own, each one outcome, run for ANY brand.
 *
 *   Client past employer found (`client_past_employer_found`)  dy_client_past_employers: the companies where the
 *        brand's PAYING clients have worked (past or current). lead-service answers them with the clients, roles and
 *        dates that justify each (it reads the work history it holds, and reads a missing one on its cheapest path,
 *        on this run); brand-service judges each company's notoriety once (cross-org, persisted), finds its logo and
 *        traffic, keeps each company new for the brand with its trace and declares one Unit each on this run
 *        (`recorded_by` brand, the door fills `outcomeKey`).
 *   Press feature found (`press_feature_found`)  dy_press_mailbox: the published articles quoting the brand, read off
 *        the brand org's connected mailbox. google-service finds the messages that say one of the script's phrases
 *        (tactic `searchPhrases`, data, never a sender or outlet list); Jev judges each WHOLE email once (does it
 *        announce a piece of media that went live with the mailbox owner's words?), the model asked of the LLM
 *        completion Engine reads which of its links is the article and its outlet, title and date, scraping-service
 *        reads the article, and Jev judges whether it quotes THIS brand (a mailbox can hold several brands' quotes);
 *        brand-service keeps each article with its outlet's logo + notoriety and declares one Unit each on this run.
 *        Every judged message is kept in the Engine's storage per brand, never judged twice. At most
 *        `maxJudgedPerRun` messages per run (a run stays inside the sandbox's wall and host-call bounds): the next
 *        run goes on where this one stopped.
 *
 * Neither script names its outcome (the store doors fill it), a model (the completion is asked), a brand, a company
 * or an outlet. Never a regex reading what a message means: Jev judges, the verdict is kept.
 */
import { PORT_HEAD } from "./port-kit.js";

export const EMPLOYER_DOOR = "lead.client_past_employers";
export const EMPLOYER_STORE_DOOR = "brand.proof.employers.store";
export const MAIL_SEARCH_DOOR = "google.mail.search";
export const PRESS_STORE_DOOR = "brand.proof.press.store";

export const CLIENT_PAST_EMPLOYERS = {
  outcome: "client_past_employer_found",
  dynasty: "dy_client_past_employers",
  name: "Paying clients' past employers",
  tactics: {
    recorded_by: "brand",
    source: "the work history of the brand's paying clients",
  },
  description:
    "Finds every company where one of the brand's paying clients has worked, past or current, and keeps each one with the clients and roles behind it, its logo and how well known it is.",
} as const;

export const PRESS_MAILBOX = {
  outcome: "press_feature_found",
  dynasty: "dy_press_mailbox",
  name: "Press features in the mailbox",
  tactics: {
    recorded_by: "brand",
    asks: ["llm_completion"],
    source: "the brand org's connected mailbox",
    searchPhrases: ["now live on", "went live", "quoted in", "featured in", "article is live", "has been published"],
    maxJudgedPerRun: 25,
  },
  description:
    "Reads the brand's connected mailbox for emails announcing an article that went live with the brand's words, checks each article quotes the brand, and keeps it with its outlet, link, title and date.",
} as const;

/** The completion's answer when reading one announcing email: strict-schema ready (every property required). */
export const ARTICLE_READ_SCHEMA = {
  type: "object",
  properties: {
    articleUrl: { type: "string", description: "The link to the published piece, copied exactly from the email's links; empty when none of them is." },
    outlet: { type: "string", description: "The publication's name as the email states it (a magazine, a newsletter, a site, a podcast)." },
    outletDomain: { type: "string", description: "The publication's OWN website domain (example.com) when it has one; empty when the piece is hosted on a platform that is not the publication (a LinkedIn newsletter, a Substack, a Medium page)." },
    title: { type: "string", description: "The piece's title as the email states it (never a link or a URL slug); empty when it states none." },
    publishedAt: { type: "string", description: "The date it went live, YYYY-MM-DD, when the email states one; empty otherwise." },
  },
  required: ["articleUrl", "outlet", "outletDomain", "title", "publishedAt"],
  additionalProperties: false,
} as const;

export const ANNOUNCES_QUESTION =
  "Does this email tell the mailbox's owner that a published piece (an article, a newsletter issue, a podcast or video page) has gone live with their own words, quote or insights in it? Yes only for something already published. No for an invitation or request to contribute, a pitch, a newsletter that is only about a topic, a product or event launch, a receipt, or anything else.";

export const QUOTES_BRAND_QUESTION =
  "Does this published piece quote or feature THE BRAND described in the state, or a person speaking for it (its founder or its team)? The mailbox may belong to someone who speaks for several brands: answer yes only when the piece, or the email announcing it, ties the words to this brand (its name, its website, or a person presented as working on it). When the piece could not be read, judge on the email alone.";

export const ARTICLE_READ_PROMPT = [
  "You read one email announcing that a published piece went live with the reader's words in it.",
  "Answer which of the email's links is the published piece itself (copy it exactly; never a link to the sending platform's own site, a sign-in, a share or an unsubscribe link), the publication's name and its own website when it has one, the piece's title and the date it went live.",
  "Use only what the email states. An unknown field is an empty string.",
].join("\n");

/** Most characters of an email or an article handed to a judge or the reader. */
export const MAIL_MAX_CHARS = 8000;
/**
 * What the judge reads of an article: its opening, then every passage that names the brand (its name or its site,
 * any case), up to this cap. A roundup quoting 60 people names the brand far down the page (the first 12k characters
 * of « How to Control AI API Costs », Substack, never reached « Kevin Lourd, Founder of Distribute.you »), and Jev's
 * window refuses a whole one (80k characters: `max_tokens_exceeded`). Choosing which passages to show is retrieval,
 * never a verdict: Jev still judges whether the piece quotes the brand.
 */
export const PAGE_MAX_CHARS = 16000;
export const PAGE_OPENING_CHARS = 4000;
export const PASSAGE_RADIUS_CHARS = 1200;
/** The verdicts' storage table: a new judging rule = a new table, every message judged again under it. */
export const JUDGED_TABLE = "judged_v3";

/** Plain JS (no types): embedded in the script and evaluated as-is by the tests. */
export const ARTICLE_VIEW_FN = `/** The article's opening, then each passage naming one of the brand's words (merged when they overlap), capped. */
function articleView(text, words) {
  if (text.length <= PAGE_MAX_CHARS) return text;
  const low = text.toLowerCase();
  const spans = [[0, PAGE_OPENING_CHARS]];
  for (const w of words.map((x) => String(x || "").toLowerCase()).filter((x) => x.length > 2)) {
    for (let i = low.indexOf(w); i >= 0; i = low.indexOf(w, i + w.length)) spans.push([Math.max(0, i - PASSAGE_RADIUS_CHARS), Math.min(text.length, i + w.length + PASSAGE_RADIUS_CHARS)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([sp[0], sp[1]]);
  }
  let out = "";
  for (const [a, b] of merged) {
    const piece = (a > 0 ? "[...] " : "") + text.slice(a, b);
    if (out.length + piece.length > PAGE_MAX_CHARS) { out += piece.slice(0, Math.max(0, PAGE_MAX_CHARS - out.length)); break; }
    out += piece + "\\n";
  }
  return out;
}`;

export function buildClientPastEmployersSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Client past employer found: the companies where the brand's paying clients worked, kept by brand-service with their trace (BRAND-PROOF-LOGOS-1121). */`,
    PORT_HEAD,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const now = typeof R.now === "string" ? R.now : "";
  const day = now.slice(0, 10);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) throw new Error("client-past-employers: the run states no clock (request.now): " + JSON.stringify(R.now));
  const brandId = Array.isArray(R.brandIds) && R.brandIds.length ? String(R.brandIds[0]) : String((ctx as any).brand ?? "");
  if (!brandId) throw new Error("client-past-employers: no brand on this run");

  // lead-service looks up the careers it holds none for (on this run, its cheapest path first), then answers the read.
  let read: any = null;
  for (let i = 0; i < 3; i++) {
    read = must(ctx, ${JSON.stringify(EMPLOYER_DOOR)}, { params: { brandId } });
    if (!read.lookups || !(read.lookups.remaining > 0)) break;
  }
  const companies: any[] = (Array.isArray(read.companies) ? read.companies : []).filter((c: any) => c && (c.domain || c.name));
  if (!companies.length) return { unmade: "no_employer: " + String(read.reason ?? "no company named by the brand's paying clients' work history") + " (" + String(read.payingClients ?? 0) + " paying clients, " + String(read.clientsWithHistory ?? 0) + " with a history)" };

  // brand-service keys a company on its domain, else its LinkedIn page: a name alone never identifies it.
  const employers = companies
    .filter((c: any) => c.domain || c.linkedinUrl)
    .map((c: any) => ({
      company: { domain: c.domain ?? null, linkedinUrl: c.linkedinUrl ?? null, name: c.name ?? null },
      trace: (Array.isArray(c.clients) ? c.clients : []).filter((x: any) => x && x.leadId).map((x: any) => ({ leadId: String(x.leadId), role: x.title ?? null })),
    }))
    .filter((e: any) => e.trace.length);
  const unnamed = companies.length - employers.length;
  if (!employers.length) return { unmade: "no_identifiable_employer: none of the " + companies.length + " companies states a website or a LinkedIn page" };
  const kept: any[] = [];
  let pendingNotoriety = 0;
  for (let i = 0; i < employers.length; i += 200) {
    const chunk = employers.slice(i, i + 200);
    const stored = tolerated(ctx, ${JSON.stringify(EMPLOYER_STORE_DOOR)}, { params: { brandId }, body: { employers: chunk } });
    // A notoriety judgment that failed leaves the Units stored and declared: the next run's store retries it.
    if (stored.ok === false) {
      if (String(stored.error).includes("notoriety_unavailable")) { pendingNotoriety += chunk.length; continue; }
      throw new Error(${JSON.stringify(EMPLOYER_STORE_DOOR)} + " failed (" + String(stored.status ?? "") + "): " + String(stored.error).slice(0, 500));
    }
    for (const u of Array.isArray(stored.units) ? stored.units : []) {
      if (u.newUnit !== true) continue;
      const e = chunk[u.index] ?? {};
      kept.push({ unitId: u.unitId, companyId: u.companyId, domain: e.company?.domain ?? null, name: e.company?.name ?? null, clients: e.trace?.length ?? 0, notoriety: u.notoriety?.score ?? null });
    }
  }
  if (!kept.length) return { unmade: "no_new_employer: the " + employers.length + " companies of the brand's paying clients are already kept" + (pendingNotoriety ? " (" + pendingNotoriety + " still waiting for a notoriety judgment)" : "") };
  return { content: { companies: companies.length, unidentified: unnamed, pendingNotoriety, kept } };
}
`,
  ].join("\n");
}

export function buildPressMailboxSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Press feature found: articles quoting the brand, read off its org's connected mailbox, judged by Jev, kept by brand-service (BRAND-PROOF-LOGOS-1121). */`,
    PORT_HEAD,
    `
const ARTICLE_READ_SCHEMA = ${JSON.stringify(ARTICLE_READ_SCHEMA)};
const ANNOUNCES_QUESTION = ${JSON.stringify(ANNOUNCES_QUESTION)};
const QUOTES_BRAND_QUESTION = ${JSON.stringify(QUOTES_BRAND_QUESTION)};
const ARTICLE_READ_PROMPT = ${JSON.stringify(ARTICLE_READ_PROMPT)};
const MAIL_MAX_CHARS = ${MAIL_MAX_CHARS};
const PAGE_MAX_CHARS = ${PAGE_MAX_CHARS};
const PAGE_OPENING_CHARS = ${PAGE_OPENING_CHARS};
const PASSAGE_RADIUS_CHARS = ${PASSAGE_RADIUS_CHARS};

${ARTICLE_VIEW_FN}
const JUDGED_TABLE = ${JSON.stringify(JUDGED_TABLE)};

/**
 * The outlet as brand-service keys it: its own site when it has one; a stated null domain = hosted on a platform (a
 * LinkedIn newsletter, a Substack), kept by its name; neither known = left out (brand-service reads the article's host).
 */
function outletOf(name: string, domain: string): Record<string, unknown> {
  if (domain) return { outlet: { name: name || null, domain } };
  if (name) return { outlet: { name, domain: null } };
  return {};
}

function probability(j: any, key: string, what: string): number {
  const p = j && j.probabilities ? j.probabilities[key] : undefined;
  if (typeof p !== "number") throw new Error("press-mailbox: Jev answered no probability on " + what);
  return p;
}

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const now = typeof R.now === "string" ? R.now : "";
  if (!/^\\d{4}-\\d{2}-\\d{2}/.test(now)) throw new Error("press-mailbox: the run states no clock (request.now): " + JSON.stringify(R.now));
  const brandId = Array.isArray(R.brandIds) && R.brandIds.length ? String(R.brandIds[0]) : String((ctx as any).brand ?? "");
  if (!brandId) throw new Error("press-mailbox: no brand on this run");
  const t: any = ctx.tactics ?? {};
  const phrases: string[] = (Array.isArray(t.searchPhrases) ? t.searchPhrases : []).map((p: any) => String(p ?? "").trim()).filter((p: string) => p.length > 2);
  if (!phrases.length) throw new Error("press-mailbox: the script states no searchPhrases (tactic: what an announcing email says)");
  const maxJudged = Number.isInteger(t.maxJudgedPerRun) && t.maxJudgedPerRun > 0 && t.maxJudgedPerRun <= 40 ? t.maxJudgedPerRun : 25;

  const brand: any = (must(ctx, "brand.profile", { params: { id: brandId } }).brand) || {};
  const brandName = String(brand.name ?? "").trim();
  const brandDomain = String(brand.domain ?? "").trim();
  if (!brandName) throw new Error("press-mailbox: the brand states no name");

  // Every message already judged for this brand, never judged twice (kept per brand in the Engine's storage).
  const judged: Record<string, string> = (ctx.storage.get(JUDGED_TABLE, brandId) as any) ?? {};
  // Articles kept while their outlet's notoriety could not be judged: stored again (idempotent) so it is judged now.
  let pending: any[] = (ctx.storage.get("pending_notoriety", brandId) as any) ?? [];
  if (pending.length) {
    const again = tolerated(ctx, ${JSON.stringify(PRESS_STORE_DOOR)}, { params: { brandId }, body: { features: pending.slice(0, 200) } });
    if (again.ok !== false) { pending = pending.slice(200); ctx.storage.set("pending_notoriety", brandId, pending); }
  }
  const candidates: any[] = [];
  let searched = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 10 && candidates.length < maxJudged; page++) {
    const found = must(ctx, ${JSON.stringify(MAIL_SEARCH_DOOR)}, { body: { phrases, limit: 50, ...(cursor ? { cursor } : {}) } });
    if (found.reason) return { unmade: "no_mailbox: " + String(found.reason) + " (the brand's organization connected no mailbox)" };
    const messages: any[] = Array.isArray(found.messages) ? found.messages : [];
    searched += messages.length;
    for (const m of messages) {
      const id = String(m.id ?? "");
      if (!id || judged[id]) continue;
      candidates.push(m);
      if (candidates.length >= maxJudged) break;
    }
    cursor = typeof found.nextCursor === "string" && found.nextCursor ? found.nextCursor : null;
    if (!cursor) break;
  }
  if (!candidates.length) return { unmade: "no_new_message: no message of the brand's mailbox saying one of the phrases is left to judge (" + searched + " found, all judged)" };

  const brandState = { name: brandName, website: brandDomain || null };
  const kept: any[] = [];
  const counts = { judged: 0, notAnnouncing: 0, notThisBrand: 0, kept: 0 };
  for (const m of candidates) {
    const id = String(m.id);
    const email = {
      from: [m.fromName, m.fromEmail].filter(Boolean).join(" ") || null,
      to: Array.isArray(m.to) ? m.to : [],
      subject: m.subject ?? null,
      sentAt: m.sentAt ?? null,
      text: String(m.bodyText ?? m.snippet ?? "").slice(0, MAIL_MAX_CHARS),
      links: (Array.isArray(m.links) ? m.links : []).slice(0, 60).map((l: any) => ({ url: String(l.url ?? ""), text: l.text ?? null })).filter((l: any) => l.url),
    };
    counts.judged++;
    const a = must(ctx, "jev.noul", { state: { mailboxOf: "the brand's own organization", email }, questions: { announces: { instructions: ANNOUNCES_QUESTION } } });
    if (probability(a, "announces", "the announcement") < 0.5) {
      judged[id] = "not_announcing";
      counts.notAnnouncing++;
      ctx.storage.set(JUDGED_TABLE, brandId, judged);
      continue;
    }
    const links: string[] = email.links.map((l: any) => String(l.url));
    ctx.ask({ units: {}, request: { message: JSON.stringify(email), systemPrompt: ARTICLE_READ_PROMPT, maxTokens: 800, responseFormat: "json", responseSchema: ARTICLE_READ_SCHEMA, strictResponseSchema: ARTICLE_READ_SCHEMA } });
    const done: any = ctx.get("llm_completion");
    if (!done.content) throw new Error("llm_completion: " + String(done.unmade ?? "no completion"));
    const r: any = (done.content.answer && done.content.answer.json) || {};
    const articleUrl = links.includes(String(r.articleUrl ?? "").trim()) ? String(r.articleUrl).trim() : "";
    const outlet = String(r.outlet ?? "").trim();
    const outletDomain = String(r.outletDomain ?? "").trim().toLowerCase().replace(/^https?:[/][/]/, "").replace(/^www[.]/, "").split("/")[0];
    const title = String(r.title ?? "").trim();
    const publishedAt = /^\\d{4}-\\d{2}-\\d{2}$/.test(String(r.publishedAt ?? "").trim()) ? String(r.publishedAt).trim() : "";

    let pageText = "";
    if (articleUrl) {
      const page = tolerated(ctx, "scraping.page", { body: { url: articleUrl, enrich: false, brandIds: [brandId] } });
      pageText = articleView(String(page.result?.rawMarkdown ?? ""), [brandName, brandDomain]);
    }
    const q = must(ctx, "jev.noul", {
      state: { brand: brandState, email, article: articleUrl ? { url: articleUrl, outlet, title, text: pageText || "(the page could not be read)" } : "(the email links to no published piece)" },
      questions: { quotesBrand: { instructions: QUOTES_BRAND_QUESTION } },
    });
    const pq = probability(q, "quotesBrand", "the brand");
    if (pq < 0.5) {
      judged[id] = "not_this_brand";
      counts.notThisBrand++;
      ctx.storage.set(JUDGED_TABLE, brandId, judged);
      continue;
    }
    if (!articleUrl) {
      judged[id] = "no_article_link";
      counts.notThisBrand++;
      ctx.storage.set(JUDGED_TABLE, brandId, judged);
      continue;
    }
    const feature = { articleUrl, title: title || null, publishedAt: publishedAt || (/^\\d{4}-\\d{2}-\\d{2}/.test(String(m.sentAt ?? "")) ? String(m.sentAt).slice(0, 10) : null), ...outletOf(outlet, outletDomain) };
    const stored = tolerated(ctx, ${JSON.stringify(PRESS_STORE_DOOR)}, { params: { brandId }, body: { features: [feature] } });
    if (stored.ok === false && !String(stored.error).includes("notoriety_unavailable")) throw new Error(${JSON.stringify(PRESS_STORE_DOOR)} + " failed (" + String(stored.status ?? "") + "): " + String(stored.error).slice(0, 500));
    // Stored either way; a failed notoriety judgment is retried by storing it again on a later run.
    if (stored.ok === false) pending.push(feature);
    judged[id] = "kept";
    counts.kept++;
    ctx.storage.set(JUDGED_TABLE, brandId, judged);
    ctx.storage.set("pending_notoriety", brandId, pending);
    const u: any = stored.ok === false ? null : (Array.isArray(stored.units) ? stored.units[0] : null);
    kept.push({ outlet, articleUrl, title: title || null, publishedAt: feature.publishedAt, newUnit: u ? u.newUnit === true : null, notoriety: u?.notoriety?.score ?? null });
  }
  if (!kept.length) return { unmade: "no_press_feature: none of the " + counts.judged + " messages judged announces a piece quoting the brand (" + counts.notAnnouncing + " announce nothing, " + counts.notThisBrand + " not this brand)" };
  return { content: { ...counts, kept } };
}
`,
  ].join("\n");
}
