/**
 * ENGINE-GET-ASK-1123 (owner 2026-11-23, about the page reads and judgments scripts make through raw doors: « pourquoi
 * ne pas les mettre dans Engine too? », go 2026-11-24): every stored script that read a web page (`scraping.page`) or
 * asked a judgment (`jev.noul`, `chat.judgment`) through a raw door is UPGRADED, from its STORED code (the source of
 * truth), so it ASKS the Engine instead: Page read (`page_read`) and Judgment made (`judgment_made`).
 *
 *   ctx.ask({ units: {}, request: <the call's own fields> }); ctx.get("<engine outcome>")
 *
 * The rewrite is mechanical, the same for every script, and touches the call's first token only:
 *   - `tolerated(ctx, "scraping.page", X)`    -> `askPageTolerated(ctx, X)` (the page, else `{ok: false, status, error}`);
 *   - `must(ctx, "jev.noul", X)`              -> `askYesNoMust(ctx, X)` (`{probabilities, model}`, else a throw);
 *   - `ctx.vendor.call("jev.noul", X)`        -> `askYesNo(ctx, X)` (`{ok, data}`, as the door answered);
 *   - a DAG port's `callStep(ctx, "scraping.page" | "chat.judgment", …)` names the Engine instead, and its ONE vendor
 *     line routes those two to `askPage` / `askJudgment` (same `{ok, data}`, so every line after it reads as before).
 * Each helper answers what the raw door answered, so no other line of a script changes; only the helpers a script
 * uses are appended (the catalogue reads a script's materials off its code), and its tactic `asks` gains the Engine.
 * A script still naming a raw door after it, or one whose anchor moved, throws: nothing is generated.
 *
 * What the Request holds: a page read = `url, enrich, render, maxAgeDays, skipCache, options` (what the raw call also
 * stated about the RUN, `brandIds, campaignId, featureSlug, workflowSlug`, rides the asked run's own headers; any other
 * field is a named throw, never dropped); a judgment = `questions, state?, image?` (the judge is the Engine script's).
 *
 * What an asked Engine answers: a Unit (`content`), a page it already held (`unmade: stored_read`, the page in
 * `answer`: handed back as the page), or a refusal the door answered (`unmade: "<code>: <words> (<status>)"`: handed
 * back as `{ok: false, data: {error, status, code}}`, so a tolerated read stays tolerated). A call with NO answer
 * (transport) is `unmade` too (`page_not_read: <error>`, no status): a tolerated read goes on without the page, as before.
 *
 * NOT migrated (`NOT_MIGRATED`): a script a service runs platform-billed (`POST /internal/scripts/run`): its Jev call
 * is chat-service's PLATFORM door, the Judgment made script asks the ORG door as a run of an org.
 */

export const PAGE_READ = "page_read";
export const JUDGMENT_MADE = "judgment_made";
export const RAW_PAGE_DOOR = "scraping.page";
export const RAW_JUDGMENT_DOORS = ["jev.noul", "jev.choice", "chat.judgment"];
export const ASK_PAGE_JUDGMENT_MARK = "ENGINE-GET-ASK-1123: this script asks the";

/** The fields a page read's Request holds (the Page read script reads exactly these). */
export const PAGE_REQUEST_FIELDS = ["url", "enrich", "render", "maxAgeDays", "skipCache", "options"];
/** What a raw page call also stated about the run itself: the asked run carries it (its headers). */
export const PAGE_RUN_FIELDS = ["brandIds", "campaignId", "featureSlug", "workflowSlug"];

/** The active scripts that asked a raw page or judgment door on 2026-11-24 (production, `scripts`). */
export const ASK_PAGE_JUDGMENT_SCRIPTS: Array<{ outcome: string; dynasty: string }> = [
  { outcome: "lead_interested", dynasty: "dy_follow_up_due" },
  { outcome: "paid_client", dynasty: "dy_client_check_in" },
  { outcome: "paid_client", dynasty: "dy_brand_team" },
  { outcome: "client_satisfied", dynasty: "dy_client_whatsapp" },
  { outcome: "linkedin_post_published", dynasty: "dy_linkedin_post" },
  { outcome: "x_post_published", dynasty: "dy_x_post" },
  { outcome: "threads_post_published", dynasty: "dy_threads_thread" },
  { outcome: "threads_post_published", dynasty: "dy_threads_shape_rotation" },
  { outcome: "threads_post_published", dynasty: "dy_threads_contrarian_take" },
  { outcome: "paid_client", dynasty: "dy_intro_path" },
  { outcome: "email_sent", dynasty: "dy_intro_open" },
  { outcome: "email_sent", dynasty: "dy_intro_lead_to_lead" },
  { outcome: "email_sent", dynasty: "dy_intro_client_to_lead" },
  { outcome: "message_sent", dynasty: "dy_intro_answer" },
  { outcome: "backlink_earned", dynasty: "dy_listicle_outreach" },
  { outcome: "press_feature_found", dynasty: "dy_press_mailbox" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_sender_client_brand" },
];

const PLATFORM_BILLED =
  "runs platform-billed through POST /internal/scripts/run, so its Jev call is chat-service's PLATFORM door (/internal/platform-judgments); the Judgment made script asks the ORG door (/orgs/judgments) as a run of an org: asking it would change who pays, and refuse a run with no org";
export const NOT_MIGRATED: Array<{ outcome: string; dynasty: string; reason: string }> = [
  { outcome: "lead_identified", dynasty: "dy_screen_reveal", reason: `lead-service's candidate decision ${PLATFORM_BILLED}` },
  { outcome: "email_reply_received", dynasty: "dy_orphan_reply", reason: `instantly-service's orphan reply judgment ${PLATFORM_BILLED}` },
];

const REFUSAL_HELPER = `
/** ${ASK_PAGE_JUDGMENT_MARK} Engine (page read, judgment) instead of a raw door; a refusal the Engine's door answered, read back as the door stated it. */
function askedRefusal(done: any, none: string): { ok: boolean; data: Record<string, any> } {
  const unmade = String((done && done.unmade) || none);
  const at = unmade.indexOf(": ");
  const code = at > 0 ? unmade.slice(0, at) : "";
  const words = at > 0 ? unmade.slice(at + 2) : unmade;
  const m = /^([\\s\\S]*) \\((\\d{3})\\)(?: for [\\s\\S]*)?$/.exec(words);
  const data: Record<string, any> = { error: m ? m[1] : words, code: code && code !== "page_not_read" && code !== "judgment_not_made" ? code : null, body: {} };
  if (m) data.status = Number(m[2]);
  return { ok: false, data };
}
`;

const PAGE_HELPERS = `
/** One web page, asked of the Page read Engine: the page as the raw page door answered it, else its refusal. */
function askPage(ctx: any, call: Record<string, any>): { ok: boolean; data: Record<string, any> } {
  const body: Record<string, any> = (call && call.body) || {};
  const request: Record<string, unknown> = {};
  for (const k of Object.keys(body)) {
    if (body[k] === undefined) continue;
    if (${JSON.stringify(PAGE_REQUEST_FIELDS)}.indexOf(k) >= 0) request[k] = body[k];
    else if (${JSON.stringify(PAGE_RUN_FIELDS)}.indexOf(k) < 0) throw new Error("${PAGE_READ}: the read states " + k + ", which a page read's Request does not hold");
  }
  if (typeof request.url !== "string" || !request.url.trim()) return { ok: false, data: { error: "${PAGE_READ}: the read names no page (url)", code: null, body: {} } };
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("${PAGE_READ}");
  if (done && done.content) return { ok: true, data: done.content };
  // A page the reader already held: no new read, no Unit; the page comes back as the answer.
  if (done && done.answer && typeof done.answer === "object") return { ok: true, data: done.answer };
  return askedRefusal(done, "no page read");
}
function askPageTolerated(ctx: any, call: Record<string, any>): any {
  const r = askPage(ctx, call);
  if (r.ok) return r.data;
  return { ok: false, status: r.data.status ?? null, error: String(r.data.error ?? "") };
}
`;

const JUDGMENT_HELPERS = `
/** Typed questions, asked of the Judgment made Engine: the judge's whole answer, else its refusal. */
function askedJudgment(ctx: any, questions: any, state: any, image: any): { ok: boolean; data: Record<string, any> } {
  if (!questions || typeof questions !== "object" || Array.isArray(questions) || Object.keys(questions).length === 0) return { ok: false, data: { error: "${JUDGMENT_MADE}: the judgment asks no question", code: null, body: {} } };
  if (state === undefined && image === undefined) return { ok: false, data: { error: "${JUDGMENT_MADE}: the judgment states nothing to judge", code: null, body: {} } };
  const request: Record<string, unknown> = { questions };
  if (state !== undefined) request.state = state;
  if (image !== undefined) request.image = image;
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("${JUDGMENT_MADE}");
  if (done && done.content) return { ok: true, data: done.content };
  return askedRefusal(done, "no judgment");
}
/** A judgment call as a step stated it ({body: {questions, state?, image?}}): the judge's whole answer. */
function askJudgment(ctx: any, call: Record<string, any>): { ok: boolean; data: Record<string, any> } {
  const body: Record<string, any> = (call && call.body) || {};
  for (const k of Object.keys(body)) {
    if (body[k] !== undefined && k !== "questions" && k !== "state" && k !== "image") throw new Error("${JUDGMENT_MADE}: the judgment states " + k + ", which a judgment's Request does not hold");
  }
  return askedJudgment(ctx, body.questions, body.state, body.image);
}
/** Yes / no questions ({state?, questions: {<key>: {instructions, whenTrue?, whenFalse?}}}): {probabilities, model}. */
function askYesNo(ctx: any, args: Record<string, any>): { ok: boolean; data: Record<string, any> } {
  const questions: Record<string, any> | undefined = args && args.questions;
  if (!questions || typeof questions !== "object" || Object.keys(questions).length === 0) return { ok: false, data: { error: "a yes / no judgment needs questions" } };
  const text = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : "");
  const wire: Record<string, Record<string, unknown>> = {};
  for (const k of Object.keys(questions)) {
    const q = questions[k] || {};
    const instructions = text(q.instructions);
    if (!instructions) return { ok: false, data: { error: "yes / no question " + k + " needs instructions" } };
    wire[k] = { type: "noul", instructions, ...(text(q.whenTrue) && text(q.whenFalse) ? { criteria: { true: q.whenTrue, false: q.whenFalse } } : {}) };
  }
  const r = askedJudgment(ctx, wire, args.state, undefined);
  if (!r.ok) return r;
  const answers: Record<string, any> = r.data.answers || {};
  const probabilities: Record<string, number> = {};
  for (const k of Object.keys(wire)) {
    const p = answers[k] ? answers[k].noul : undefined;
    if (typeof p !== "number" || !isFinite(p) || p < 0 || p > 1) return { ok: false, data: { error: "judgment " + k + " answered without a readable probability" } };
    probabilities[k] = p;
  }
  return { ok: true, data: { probabilities, model: r.data.model ?? null } };
}
function askYesNoMust(ctx: any, args: Record<string, any>): any {
  const r = askYesNo(ctx, args);
  if (!r.ok) throw new Error("${JUDGMENT_MADE} failed (" + String(r.data.status ?? "") + "): " + String(r.data.error ?? "").slice(0, 500));
  return r.data;
}
`;

/** A DAG port's one vendor line (dag-port.ts `callStep`): the two Engines are asked there, every other door called. */
const DAG_VENDOR_LINE = `    const r: { ok: boolean; data: any } = ctx.vendor.call(door, args);`;
const DAG_PAGE = `callStep(ctx, "${PAGE_READ}", `;
const DAG_JUDGMENT = `callStep(ctx, "${JUDGMENT_MADE}", `;

const swap = (code: string, from: string, to: string): { code: string; n: number } => {
  const parts = code.split(from);
  return { code: parts.join(to), n: parts.length - 1 };
};

/** A quoted raw page / judgment door name left in a script's code (a call the rewrite did not move). */
export function namesARawDoor(code: string): string | null {
  for (const d of [RAW_PAGE_DOOR, ...RAW_JUDGMENT_DOORS]) for (const q of ['"', "'", "`"]) if (code.includes(q + d + q)) return d;
  return null;
}

/**
 * The upgrade of one script's stored code, and the Engines it now asks. `what` names it in an error. Throws when the
 * script already asks, calls neither door, or still names one after the rewrite.
 */
export function askPageJudgmentSource(stored: string, what: string): { code: string; asks: string[] } {
  if (stored.includes(ASK_PAGE_JUDGMENT_MARK)) throw new Error(`${what}: already asks its page reads and judgments`);
  let code = stored;
  let pages = 0;
  let judgments = 0;
  const move = (from: string, to: string): number => {
    const r = swap(code, from, to);
    code = r.code;
    return r.n;
  };
  pages += move(`tolerated(ctx, "${RAW_PAGE_DOOR}", `, "askPageTolerated(ctx, ");
  judgments += move(`must(ctx, "jev.noul", `, "askYesNoMust(ctx, ");
  judgments += move(`ctx.vendor.call("jev.noul", `, "askYesNo(ctx, ");
  const dagPages = move(`callStep(ctx, "${RAW_PAGE_DOOR}", `, DAG_PAGE);
  const dagJudgments = move(`callStep(ctx, "chat.judgment", `, DAG_JUDGMENT);
  if (dagPages + dagJudgments > 0) {
    const n = code.split(DAG_VENDOR_LINE).length - 1;
    if (n !== 1) throw new Error(`${what}: its step caller's vendor line is found ${n} times (the stored code moved: re-read it)`);
    const routed = `${dagPages > 0 ? `door === "${PAGE_READ}" ? askPage(ctx, args) : ` : ""}${dagJudgments > 0 ? `door === "${JUDGMENT_MADE}" ? askJudgment(ctx, args) : ` : ""}ctx.vendor.call(door, args)`;
    code = code.replace(DAG_VENDOR_LINE, () => `    // ENGINE-GET-ASK-1123: a page read and a judgment are asked of their Engines.\n    const r: { ok: boolean; data: any } = ${routed};`);
  }
  pages += dagPages;
  judgments += dagJudgments;
  if (pages + judgments === 0) throw new Error(`${what}: calls no raw page or judgment door the rewrite knows`);
  const left = namesARawDoor(code);
  if (left) throw new Error(`${what}: still names ${left} after the rewrite (a call form the rewrite does not know: re-read the stored code)`);
  const asks = [...(pages > 0 ? [PAGE_READ] : []), ...(judgments > 0 ? [JUDGMENT_MADE] : [])];
  return { code: code.trimEnd() + "\n" + REFUSAL_HELPER + (pages > 0 ? PAGE_HELPERS : "") + (judgments > 0 ? JUDGMENT_HELPERS : ""), asks };
}

/** The script's tactics, plus the Engines it now asks. */
export function askPageJudgmentTactics(current: Record<string, unknown>, asked: string[]): Record<string, unknown> {
  const asks = Array.isArray(current.asks) ? (current.asks as unknown[]).filter((a): a is string => typeof a === "string") : [];
  return { ...current, asks: [...asks, ...asked.filter((a) => !asks.includes(a))] };
}

interface RecordedCall {
  name: string;
  args?: Record<string, unknown> | null;
  answer: { ok: boolean; data: Record<string, unknown> };
}

const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One recorded case restated: each recorded page read or judgment leaves `calls` and becomes, in order, a Unit the
 * case holds of its Engine, its recorded request the asked Request. A replayed case hands a held Unit as `content`
 * only, so a record whose call made no Unit (a refusal, a read answered from a held page) or had no answer (a failed
 * asked run stops the asker) is EXCLUDED with its reason, never restated. A case holding no such call is unchanged.
 */
export function restateCaseForAskedPageJudgment(c: Record<string, any>): { case: Record<string, any>; restated: number } | { excluded: string } {
  const calls: RecordedCall[] = Array.isArray(c.calls) ? c.calls : [];
  const kept: RecordedCall[] = [];
  const held: Record<string, Array<Record<string, unknown>>> = {};
  const asks: Array<Record<string, unknown>> = [];
  let allRecorded = true;
  let restated = 0;
  for (const call of calls) {
    const page = call.name === RAW_PAGE_DOOR;
    if (!page && !RAW_JUDGMENT_DOORS.includes(call.name)) {
      kept.push(call);
      continue;
    }
    if (call.name === "jev.choice") return { excluded: "its record holds a jev.choice (not asked of the Judgment made Engine)" };
    const data = call.answer?.data ?? {};
    if (!call.answer?.ok) {
      return { excluded: typeof data.status === "number" ? `its record holds a refused ${call.name} (${data.status}): an asked Engine's refusal makes no Unit a case can hold` : `its record holds a ${call.name} with no answer (a failed asked run now stops the asker)` };
    }
    if (page && data.cached === true) return { excluded: "its record holds a page answered from a read already held: the Page read Engine makes no Unit for it, which a case cannot hold" };
    const body = plain(call.args) ? (plain(call.args.body) ? call.args.body : call.args) : null;
    let request: Record<string, unknown> | null = null;
    let content: Record<string, unknown> = data;
    if (page) {
      if (body) request = Object.fromEntries(PAGE_REQUEST_FIELDS.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
    } else if (call.name === "jev.noul") {
      // The door answered {probabilities, model}: the Engine's Unit is the judge's whole answer.
      const probabilities = plain(data.probabilities) ? data.probabilities : {};
      content = { answers: Object.fromEntries(Object.entries(probabilities).map(([k, p]) => [k, { noul: p }])), model: data.model ?? null };
      const questions = body && plain(body.questions) ? (body.questions as Record<string, Record<string, unknown>>) : null;
      if (body && questions) {
        const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : "");
        const wire = Object.fromEntries(
          Object.entries(questions).map(([k, q]) => [k, { type: "noul", instructions: text(q?.instructions), ...(text(q?.whenTrue) && text(q?.whenFalse) ? { criteria: { true: q.whenTrue, false: q.whenFalse } } : {}) }]),
        );
        request = { questions: wire, ...(body.state !== undefined ? { state: body.state } : {}) };
      }
    } else if (body) {
      request = { questions: body.questions, ...(body.state !== undefined ? { state: body.state } : {}), ...(body.image !== undefined ? { image: body.image } : {}) };
    }
    const outcome = page ? PAGE_READ : JUDGMENT_MADE;
    (held[outcome] ??= []).push(content);
    if (request) asks.push({ units: {}, request });
    else allRecorded = false;
    restated++;
  }
  if (restated === 0) return { case: c, restated: 0 };
  const out: Record<string, any> = { ...c, calls: kept, units: { ...(c.units ?? {}), ...held } };
  // The record's other asks interleave with these in an order the record does not keep: unchecked then.
  if (allRecorded && (c.asks === undefined || (Array.isArray(c.asks) && c.asks.length === 0))) out.asks = asks;
  else delete out.asks;
  return { case: out, restated };
}
