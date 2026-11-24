/**
 * ENGINE-GET-ASK-1123 (owner 2026-11-23, about the page reads and judgments scripts make through raw doors: « pourquoi
 * ne pas les mettre dans Engine too? »): two Engines any script, or Distry outside a campaign, can ASK
 * (`ctx.ask("<outcome>", {request})`, `POST /internal/engines/{outcome}/make`). Each is ONE code whose vendor is its
 * tactic, like the LLM completion Engine (llm-completion.ts); the Request is the door's own, stated field by field.
 *
 * - `page_read` (« Page read »: one Unit = one web page read): scraping-service's page door (`scraping.page`, `POST
 *   /scrape`) on the script's run. scraping-service declares NOTHING for a page read (it declares only what a caller
 *   states the read is FOR, `company_researched`), so the RUNNER declares the Unit, under the id scraping-service's
 *   Provider read lists it by (`GET /orgs/page-reads`, `listPageReadUnits`: the `scrape_requests` row id, served as
 *   `requestId` on a fresh read): `{service: "scraping-service", id: <requestId>}`. A call answered from a read
 *   scraping-service already holds made no new read (its own rule: « has no Unit of its own »): the script hands the
 *   page back as its `answer` and makes no Unit, so nothing is declared twice.
 * - `judgment_made` (« Judgment made »: one Unit = one judgment answered): chat-service's typed judgments
 *   (`chat.judgment`, `POST /orgs/judgments`) on the script's run, the judge its tactic `judge` (+ `model`, only when
 *   stated: never a model in code). chat-service declares no Unit: the runner does, about the subject the asker names,
 *   else the asking run.
 *
 * Neither checks, retries or rewrites an answer. A refusal the door ANSWERED (a status) is `unmade: "<code>: <words>"`,
 * its code when it names one; no answer at all (the door was not reached) is `unmade` too, so an asker that tolerates the read goes on. A Request that cannot be asked is a named throw.
 */
import { PORT_HEAD } from "./port-kit.js";

export const PAGE_READ = "page_read";
export const JUDGMENT_MADE = "judgment_made";
/** The service whose rows a page read is listed by (its Provider read's Unit `id`). */
export const PAGE_READ_SUBJECT_SERVICE = "scraping-service";

export interface EngineScript {
  outcome: string;
  dynasty: string;
  name: string;
  description: string;
  tactics: Record<string, unknown>;
  code: string;
}

/** The one code every page reader runs: which reader is its tactic (`provider`, when a dynasty states one). */
export function buildPageReadSource(): string {
  return `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
${PORT_HEAD}
/** Page read (ENGINE-GET-ASK-1123): the page the asker names, read through this script's reader, handed back whole. */
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  const url = typeof r.url === "string" ? r.url.trim() : "";
  if (!url) throw new Error("the request names no page to read (request.url: the page's full URL, https included)");
  const body: any = { url };
  // The door's own fields, passed as stated; one not stated is left to the door.
  if (r.enrich !== undefined) body.enrich = r.enrich;
  if (r.render !== undefined) body.render = r.render;
  if (r.maxAgeDays !== undefined) body.maxAgeDays = r.maxAgeDays;
  if (r.skipCache !== undefined) body.skipCache = r.skipCache;
  if (r.options !== undefined) body.options = r.options;
  if (typeof t.provider === "string" && t.provider) body.provider = t.provider;
  const a: Answer = ctx.vendor.call("scraping.page", { body });
  if (!a.ok) {
    const d: any = a.data ?? {};
    // No answer at all (the reader was not reached): no page was read. An answer the asker reads, so a read it tolerates stays tolerated.
    if (typeof d.status !== "number") return { unmade: "page_not_read: " + String(d.error ?? "no answer") };
    return { unmade: (typeof d.code === "string" && d.code ? d.code : "page_not_read") + ": " + String(d.error ?? "the reader answered " + d.status) + " (" + d.status + ") for " + url };
  }
  const page: any = a.data ?? {};
  // A read the reader already held: no new read was made, so no Unit; the page is handed back as the answer.
  if (page.cached === true) return { unmade: "stored_read: the page was answered from a read already held, no new read was made", decided: "done", answer: page };
  if (typeof page.requestId !== "string" || !page.requestId) throw new Error("scraping.page answered a fresh read without its requestId: the Unit cannot be named");
  return { content: page, subject: { service: "${PAGE_READ_SUBJECT_SERVICE}", id: page.requestId } };
}
`;
}

/** The one code every judge runs: the judge is its tactic (`judge`, + `model` when the dynasty states one). */
export function buildJudgmentSource(): string {
  return `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
${PORT_HEAD}
/** Judgment made (ENGINE-GET-ASK-1123): the typed questions the asker states, answered by this script's judge (tactic judge). */
export default function run(ctx: ScriptContext): ScriptResult {
  const r: any = ctx.request ?? {};
  const t: any = ctx.tactics ?? {};
  if (typeof t.judge !== "string" || !t.judge) throw new Error("this judgment script states no judge (tactic judge)");
  const questions: any = r.questions;
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) {
    throw new Error("the request asks no question (request.questions: {<key>: {type: noul | choice | score, instructions, criteria?}})");
  }
  if (r.state === undefined && r.image === undefined) throw new Error("the request states nothing to judge (request.state, request.image, or both)");
  const body: any = { questions, judge: t.judge };
  if (r.state !== undefined) body.state = r.state;
  if (r.image !== undefined) body.image = r.image;
  if (typeof t.model === "string" && t.model) body.model = t.model;
  const a: Answer = ctx.vendor.call("chat.judgment", { body });
  if (!a.ok) {
    const d: any = a.data ?? {};
    // No answer at all (the judge was not reached): no judgment was made. An answer the asker reads (one that needs it throws itself).
    if (typeof d.status !== "number") return { unmade: "judgment_not_made: " + String(d.error ?? "no answer") };
    return { unmade: (typeof d.code === "string" && d.code ? d.code : "judgment_not_made") + ": " + String(d.error ?? "the judge answered " + d.status) + " (" + d.status + ")" };
  }
  const out: any = a.data ?? {};
  if (!out.answers || typeof out.answers !== "object") throw new Error("chat.judgment (" + t.judge + ") answered without answers");
  return { content: out };
}
`;
}

/**
 * The scripts stored today. Page read: one dynasty, our own reader (scraping-service picks its provider and its
 * escalation; a dynasty pinning one states tactic `provider`). Judgment made: one dynasty per judge production's
 * scripts use, which on 2026-11-24 is Jev alone (chat-service's default judge behind `jev.noul` / `jev.choice` /
 * `chat.judgment`; no stored script names another). A new reader or judge = one more entry, stored through the catalogue.
 */
export function engineScripts(): EngineScript[] {
  return [
    {
      outcome: PAGE_READ,
      dynasty: "dy_our_page_reader",
      name: "Our page reader",
      description:
        "Reads one web page and hands back what it says. The request states url, the page's full address. It may also state enrich (false for the page text alone, without company facts), render (true for a page built in the browser), maxAgeDays (0 to 7: how old a read we already hold may be before the page is read again) and options, the reader's own.",
      tactics: {},
      code: buildPageReadSource(),
    },
    {
      outcome: JUDGMENT_MADE,
      dynasty: "dy_jev",
      name: "Jev judge",
      description:
        "Answers typed questions about a text or an image with Jev, each answer with its probabilities. The request states questions, each one a key with its type (noul for yes or no, choice among named options, score on ordered levels), its instructions and its criteria, and what to judge: state (a text or a JSON value), image (a public picture address as url), or both.",
      tactics: { judge: "jev" },
      code: buildJudgmentSource(),
    },
  ];
}
