/**
 * BRAND-SITE-WORD-1125: the lead answerer reads what the brand PUBLISHES before it answers.
 *
 * Prod 2026-11-24/25: on distribute.you's own WhatsApp line the writer told a stalled signup "The platform is free, you
 * only choose how much goes to the outreach". The words came from a stale typed offer field (`riskReversal`, typed
 * 2026-10-27, before the owner's 2026-11-17 offer: usage based, 0% markup, never "free"); the writer's prompt said THE
 * FACTS (offer answers + confirmed offer fields) are the brand's word, so it recited them. With the field cleared, the
 * writer said "I don't have the price here, the team will tell you" 8 times in 8, while the brand's own site states it.
 *
 * Owner rule: what an agent must KNOW about a business comes from its PUBLIC site, never policy pasted in a prompt. So,
 * for every brand alike (no brand, topic or keyword named here):
 *   - the SENDER (`message_sent/dy_answer_lead`) asks the Page read Engine (`page_read`) for the brand's own site, its
 *     AI index `<origin>/llms.txt` and its home page (a read held under a day is reused, no new read), right before it
 *     asks its writer, and hands the text in the writer's material as `site` (none readable = nothing handed);
 *   - the WRITER (`message_written/dy_answer_lead`) reads it as THE BRAND'S OWN WEBSITE: both it and THE FACTS are the
 *     brand's word, and when they disagree the site wins (the brand's current public word; a typed fact can be older);
 *   - when the person asks something neither holds and a page the site lists likely states it, the writer answers
 *     decision `read` with those pages (on the brand's own domain, at most SITE_MORE_PAGES); the sender reads them and
 *     asks the writer once more, now without `read` (so one look reads at most 2 + SITE_MORE_PAGES pages).
 * No `site` handed (an older sender, a recorded case) = the writer's prompt and schema byte for byte.
 *
 * The writer stays door-free (the sender reads), so its recorded writer cases stay replayable. Applied to the STORED
 * code of both halves by anchored edits (UPGRADES, writer first); a moved anchor = nothing generated.
 */

export const BRAND_SITE_MARK = "BRAND-SITE-WORD-1125";
/** At most this many more pages the writer may ask for, once. */
export const SITE_MORE_PAGES = 3;
/** A read of a page held under this many days is reused (Page read Engine, scraping-service's stored read). */
export const SITE_MAX_AGE_DAYS = 1;
/** Characters of each page the writer reads: the AI index, the home page, a page it asked for. */
export const SITE_INDEX_CHARS = 16000;
export const SITE_PAGE_CHARS = 8000;

// --- the sender ---------------------------------------------------------------------------------------------------

const SENDER_ASK_START = "  ctx.ask({ units: { answer_requested: { content: ";
const SENDER_ASK_END = ' } } }, ...(leadIdOf ? { subject: { service: "lead-service", id: leadIdOf } } : {}) });\n  const w = ctx.get("message_written");\n';

const SENDER_ASK = (content: string) => `  const answerContent = ${content};
  // ${BRAND_SITE_MARK}: the brand's own public site (its AI index and its home page), read before the writer: what it
  // publishes is the brand's current word. Nothing readable = nothing handed (the writer reads as before).
  const site = brandSite(ctx, brand);
  if (site) answerContent.site = site;
  const askWriter = function () {
    ctx.ask({ units: { answer_requested: { content: answerContent } }, ...(leadIdOf ? { subject: { service: "lead-service", id: leadIdOf } } : {}) });
    return ctx.get("message_written");
  };
  let w = askWriter();
  // The writer asked for pages of the site the person's question needs: they are read, and it is asked once more.
  if (!w.content && w.answer && w.answer.decision === "read") {
    if (!site) throw new Error("the lead answer writer asked to read the brand's site, which was never handed to it");
    answerContent.site = morePages(ctx, site, w.answer.pages);
    w = askWriter();
  }
`;

const SENDER_HELPERS = `
// ${BRAND_SITE_MARK}: the brand's own site, read through the Page read Engine (a read held under a day is reused).
function siteHostOf(v) {
  const m = /^\\s*(?:https?:\\/\\/)?([^\\/?#\\s:@]+)/i.exec(String(v || ""));
  const host = m ? m[1].toLowerCase().replace(/\\.$/, "") : "";
  return /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/.test(host) ? host : null;
}
function bareHost(host) {
  return String(host || "").toLowerCase().replace(/^www\\./, "");
}
function readSitePage(ctx, url, chars) {
  ctx.ask({ units: {}, request: { url: url, maxAgeDays: ${SITE_MAX_AGE_DAYS} } });
  const done = ctx.get("page_read");
  const page = done && done.content ? done.content : done && done.answer && typeof done.answer === "object" ? done.answer : null;
  const r = page && page.result && typeof page.result === "object" ? page.result : null;
  const text = r && typeof r.rawMarkdown === "string" ? r.rawMarkdown.trim() : "";
  if (text) return { url: url, text: text.slice(0, chars) };
  return { url: url, unread: String((done && done.unmade) || "nothing was read").slice(0, 300) };
}
function brandSite(ctx, brand) {
  const host = siteHostOf((brand && brand.url) || (brand && brand.domain));
  if (!host) return null;
  const origin = "https://" + host;
  const pages = [readSitePage(ctx, origin + "/llms.txt", ${SITE_INDEX_CHARS}), readSitePage(ctx, origin + "/", ${SITE_PAGE_CHARS})];
  if (!pages.some(function (p) { return p.text; })) return null;
  return { origin: origin, pages: pages, readMore: true };
}
function morePages(ctx, site, asked) {
  const domain = bareHost(siteHostOf(site.origin));
  const done = site.pages.map(function (p) { return p.url; });
  const urls = [];
  (Array.isArray(asked) ? asked : []).forEach(function (u) {
    const url = String(u || "").trim().replace(/#.*$/, "");
    const host = bareHost(siteHostOf(url));
    const own = /^https?:\\/\\//i.test(url) && host && (host === domain || host.slice(-(domain.length + 1)) === "." + domain);
    if (own && done.indexOf(url) < 0 && urls.indexOf(url) < 0 && urls.length < ${SITE_MORE_PAGES}) urls.push(url);
  });
  const read = urls.map(function (u) { return readSitePage(ctx, u, ${SITE_PAGE_CHARS}); });
  return { origin: site.origin, pages: site.pages.concat(read), readMore: false };
}
`;

function onlyOnce(code: string, anchor: string, what: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) throw new Error(`brand-site-word: the ${what} is not found exactly once: nothing generated`);
  return at;
}

/** The stored sender, reading the brand's own site and handing it to its writer (and reading the pages it asks for). */
export function addSiteToSender(code: string): string {
  if (code.includes(BRAND_SITE_MARK)) throw new Error("brand-site-word: the stored sender already reads the brand's site");
  const a = onlyOnce(code, SENDER_ASK_START, "writer ask");
  const b = code.indexOf(SENDER_ASK_END, a);
  if (b < 0 || code.indexOf(SENDER_ASK_END, b + 1) >= 0) throw new Error("brand-site-word: the writer ask's end is not found exactly once: nothing generated");
  const content = code.slice(a + SENDER_ASK_START.length, b) + " }"; // the content object (its closing brace opens the end anchor)
  if (!content.startsWith("{ request:") || !content.endsWith("reach: reach }")) throw new Error("brand-site-word: the writer's material moved: nothing generated");
  const edited = code.slice(0, a) + SENDER_ASK(content) + code.slice(b + SENDER_ASK_END.length);
  const k = onlyOnce(edited, "\nconst K = ", "constants line");
  return edited.slice(0, k) + "\n" + SENDER_HELPERS + edited.slice(k);
}

/** The sender's tactics: it now also asks the Page read Engine (the catalogue reads `page_read` off its code). */
export function senderTacticsWithSite(tactics: Record<string, unknown>): Record<string, unknown> {
  const asks = Array.isArray(tactics.asks) ? (tactics.asks as unknown[]).map(String) : [];
  return { ...tactics, asks: asks.includes("page_read") ? asks : [...asks, "page_read"] };
}

// --- the writer ---------------------------------------------------------------------------------------------------

/** The GAME line the site variant replaces (only when a site is handed). */
export const FACTS_LINE_START = "THE FACTS are what the brand stated.";

const SITE_FACTS = [
  "THE FACTS are what the brand stated to us; THE BRAND'S OWN WEBSITE is what the brand publishes today, read now. Both are the brand's word, and the website is the newer one: a stated fact can be older than it. When both speak of the same thing (what it costs, what they get, how it works), say it the way the website says it, and leave out a stated fact's version the website does not say. Never invent a figure, a price, a date, a promise or a status: state only what one of them says, in its words. A fact marked as not answered yet is unknown.",
];
const SITE_FACTS_READ =
  "When they ask for something neither holds yet and a page the website lists likely states it, set decision to read with those pages in pages, each copied exactly as the website lists it, at most " +
  SITE_MORE_PAGES +
  ": they are read and you decide again with them. Otherwise, when neither holds it, answer what they do hold, say plainly that you do not have the rest to give here, and make the next step the call or the booking link where the team gives it to them.";
const SITE_FACTS_FINAL =
  "When neither holds what they ask for, answer what they do hold, say plainly that you do not have the rest to give here, and make the next step the call or the booking link where the team gives it to them.";

const PAGES_PROPERTY = {
  type: "array",
  items: { type: "string" },
  description: "When decision is read: the full URLs of the brand's own pages to read, each exactly as THE BRAND'S OWN WEBSITE lists it, at most " + SITE_MORE_PAGES + ". Empty otherwise.",
};

const WRITER_SYSTEM = "  const system = [voice.content].concat(personaBlock, K.GAME, ";
const WRITER_SYSTEM_NEW = `  // ${BRAND_SITE_MARK}: a site handed = the brand's published word beside THE FACTS (the site wins when they disagree).
  const site = a.site && Array.isArray(a.site.pages) ? a.site : null;
  const gameLines = site ? K.GAME.map(function (l) { return l.indexOf(SITE.FACTS_LINE_START) === 0 ? SITE.FACTS.concat([site.readMore ? SITE.READ : SITE.FINAL]).join(" ") : l; }) : K.GAME;
  const system = [voice.content].concat(personaBlock, gameLines, `;

const WRITER_FACTS = '    "THE FACTS:\\n" + (factLines.join("\\n") || "(none stated)"),\n';
const WRITER_SITE_LINE =
  `    ...(site ? ["THE BRAND'S OWN WEBSITE (" + String(site.origin || "") + ", each page as it reads today: the brand's current public word):\\n" + site.pages.map(function (p) { return "PAGE " + String(p.url) + ":\\n" + (s(p.text) || "(could not be read: " + String(p.unread || "nothing was read") + ")"); }).join("\\n\\n")] : []),\n` +
  '    (site ? "THE FACTS (stated to us earlier; where the website above speaks of the same thing, its words replace these):\\n" : "THE FACTS:\\n") + (factLines.join("\\n") || "(none stated)"),\n';

const WRITER_SCHEMA = '  schema.properties.replyTo.enum = Object.keys(labels).concat([""]);\n';
const WRITER_SCHEMA_NEW =
  WRITER_SCHEMA +
  `  if (site && site.readMore) {
    schema.properties.decision.enum = schema.properties.decision.enum.concat(["read"]);
    schema.properties.pages = SITE.PAGES;
    schema.required = schema.required.concat(["pages"]);
  }
`;

const WRITER_NEXT = '  if (!nextOk) throw new Error("the writer gave no usable next date: "';
const WRITER_READ = `  // ${BRAND_SITE_MARK}: pages of the brand's site to read first: handed back, the sender reads them and asks again.
  if (d.decision === "read") {
    if (!site || !site.readMore) throw new Error("the writer asked to read pages when it could not");
    const pages = (Array.isArray(d.pages) ? d.pages : []).map(function (u) { return String(u || "").trim(); }).filter(Boolean).slice(0, 20); // the sender keeps the brand's own, at most SITE.MORE
    if (pages.length === 0) throw new Error("the writer asked to read pages and named none");
    return handBack({ decision: "read", pages: pages }, pages.join(", "));
  }
`;

const WRITER_CONSTANTS = () =>
  `\nconst SITE = ${JSON.stringify({ FACTS_LINE_START, FACTS: SITE_FACTS, READ: SITE_FACTS_READ, FINAL: SITE_FACTS_FINAL, PAGES: PAGES_PROPERTY, MORE: SITE_MORE_PAGES })};\n`;

/** The stored writer, reading the brand's site when its sender hands it (none handed = byte for byte as stored). */
export function addSiteToWriter(code: string): string {
  if (code.includes(BRAND_SITE_MARK)) throw new Error("brand-site-word: the stored writer already reads the brand's site");
  let out = code;
  const swap = (anchor: string, to: string, what: string) => {
    const at = onlyOnce(out, anchor, what);
    out = out.slice(0, at) + to + out.slice(at + anchor.length);
  };
  // The FACTS line must still be the one the site variant replaces.
  onlyOnce(out, JSON.stringify(FACTS_LINE_START).slice(0, -1), "FACTS game line");
  swap(WRITER_SYSTEM, WRITER_SYSTEM_NEW, "system prompt");
  swap(WRITER_FACTS, WRITER_SITE_LINE, "FACTS block");
  swap(WRITER_SCHEMA, WRITER_SCHEMA_NEW, "schema");
  swap(WRITER_NEXT, WRITER_READ + WRITER_NEXT, "next date check");
  return out.replace(/\s*$/, "\n") + WRITER_CONSTANTS();
}
