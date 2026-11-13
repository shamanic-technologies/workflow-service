/**
 * SCRIPT-VALUE-RATING-1113-WF1 (owner 2026-11-13): every outcome a campaign can target holds at least one runnable
 * script working toward it, filed under the outcome it works toward. A script of an Engine is a PATH toward its outcome:
 * it does its part by asking other outcomes, and the Unit lands when the fact is observed (a booking in the client's
 * calendar or CRM, an attended meeting), never declared by the script itself. Same shape as `dy_listicle_outreach`
 * (filed under Backlink earned, it asks for an email and the backlink is declared by whoever sees it live).
 *
 * ONE code, two dynasties, told apart by data only (tactic `goal`, the owner's words):
 *   - `meeting_booked/dy_book_meeting`   (owner: « censé avoir des scripts qui envoient des emails avec cet objectif »)
 *   - `meeting_attended/dy_meeting_reminder` (owner: a reminder before the meeting)
 *
 * Neither writes to anyone. ONE AI converses with a lead (ONE-AI-CONVERSES-1029): the script ASKS the Message sent
 * Engine (the answerer, `message_sent/dy_answer_lead`) for the one answer, handing it the run's own Request plus the
 * `goal` its answer works toward. The answerer owns every write, reads the whole thread, books a time the lead picked,
 * decides now / later / stop, and leaves the lead's one next date; it also claims the trigger EVENT for one campaign
 * (`ctx.storage.claim`), so a Lead event reaching a Meeting booked campaign AND the Lead event answer campaign of the
 * same brand yields ONE message, never two. A hand reply of ours sits in that thread like any message: it never locks it.
 *
 * A proactive tick (no occurrence) asks the answerer too: it then writes to the next lead the campaign's brand already
 * holds whose one follow-up date passed (lead-service `dueFollowupOnly`: never a fresh lead, held for this campaign's
 * claim), so a campaign launched on its Target alone never idles while such a lead waits.
 *
 * Answers: the answerer's own result (`{content: {answered}}`); its `unmade` (+ `decided`) forwarded word for word, as
 * `dy_answer_lead_pull` does. A missing `goal` throws: no default goal in code.
 */
import { PORT_HEAD } from "./port-kit.js";

const COMMON = {
  // No tactic `channel`: the outcome says WHAT (MIGRATE-1105 S5), so a campaign launched on its Target alone (no channel)
  // finds the path. A client's own-team channel (`your-team-*`, operated by the customer) is never dispatched to any
  // script, so it never runs this one.
  asks: ["message_sent"],
  // WHO it answers is the answerer's (it claims `pure_prospect` by default): stated here too, so a campaign strategy keeping
  // "Leads only" keeps the path (features-service judges the path on its own description and tactics).
  relationships: "pure_prospect",
};

export const BOOK_MEETING = {
  outcome: "meeting_booked",
  dynasty: "dy_book_meeting",
  tactics: {
    ...COMMON,
    // The booking is the client's calendar's fact (crm-service, the client's CRM): this run declares nothing.
    recorded_by: "crm",
    goal:
      "This answer works toward a booked meeting with the brand. When they show interest, propose the meeting: two open times in their timezone, or the booking link when no time fits; when they pick a time, book it and confirm it. Answer what they asked first; a meeting is the next step, never a condition.",
  },
  description:
    "Works toward a booked meeting: when a lead writes or acts, asks for the one answer that proposes a meeting with open times or the booking link, and books the time they pick. Leads only.",
} as const;

export const MEETING_REMINDER = {
  outcome: "meeting_attended",
  dynasty: "dy_meeting_reminder",
  tactics: {
    ...COMMON,
    // The attended meeting is the client's calendar's or CRM's fact: this run declares nothing.
    recorded_by: "crm",
    goal:
      "This answer works toward the lead attending the meeting they booked. When a meeting is booked, send one short reminder before it starts, in their timezone (the day before, or a few hours before when it is soon), with the time and how to join or move it, and nothing else: no pitch, no question. When the meeting is far off, choose later with the reminder's date. When no meeting is booked, answer them toward booking one.",
  },
  description:
    "Works toward an attended meeting: when a lead books or acts, asks for the one answer that reminds them of their meeting shortly before it starts, in their timezone. Leads only.",
} as const;

export function buildMeetingPathSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** A path toward a meeting outcome: asks the answerer for the one answer, with this script's goal (SCRIPT-VALUE-RATING-1113-WF1). */`,
    PORT_HEAD,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request;
  if (!R) return { unmade: "no_request" };
  const goal = typeof (ctx.tactics as any).goal === "string" ? String((ctx.tactics as any).goal).trim() : "";
  if (!goal) throw new Error("meeting path: the script states no goal (tactic goal): nothing is asked");
  ctx.ask({ units: {}, request: Object.assign({}, R, { goal: goal }), recordedBy: "sender" });
  const answer: any = ctx.get("message_sent");
  if (answer && typeof answer.unmade === "string") return { unmade: answer.unmade, ...(answer.decided === "done" || answer.decided === "idle" ? { decided: answer.decided } : {}) };
  return { content: { answered: answer.content } };
}
`,
  ].join("\n");
}

/**
 * The answerer's two edits (an UPGRADE of `message_sent/dy_answer_lead`, anchored on its STORED code, which is the
 * source of truth; every other byte unchanged, so its recorded cases replay as before):
 *   1. ONE campaign converses with a lead: right after its person claim, the run claims the LEAD for its campaign in the
 *      Engine's storage (`ctx.storage.claim`, atomic: the first campaign wins), keyed on the lead, never on the event (one
 *      reply raises several events: the positive reply AND the composite Lead event, each its own id). Another campaign
 *      answering the same lead within `ANSWER_WINDOW_MINUTES` of the owner's last answer sends nothing, rings no rep,
 *      stops only its own queue row (never the person: the owner leaves their one next date) and ends `decided: done`;
 *      past that window the lead is taken over. The owning campaign refreshes its claim on every answer.
 *   2. The asking script's goal, when the Request states one, reaches the writer as one prompt section; none = the
 *      prompt byte for byte.
 */
export const ANSWER_WINDOW_MINUTES = 30;
export const CLAIM_ANCHOR = "  const row = claim.followup;\n";
export const PROMPT_ANCHOR = "const system = [voice.content].concat(personaBlock, K.GAME, mediumLines, [";

/** v8's event claim (SCRIPT-VALUE-RATING-1113-WF1, first cut), replaced by the lead claim on the stored v8. */
export const EVENT_CLAIM_BLOCK_V8 = [
  "  // ONE answer per event (SCRIPT-VALUE-RATING-1113-WF1): several campaigns of the brand may answer the same Lead event",
  "  // (a Meeting booked path and the Lead event answer); the first to claim it answers, the others send nothing.",
  "  if (s(trigger.eventId)) {",
  '    const owner = ctx.storage.claim("answered_events", String(trigger.eventId), { campaignId: campaignId });',
  "    if (owner && owner.campaignId !== campaignId) {",
  '      must("lead.followup.record", { params: { id: row.id }, body: { kind: "stopped", reason: "answered_by_another_campaign" } });',
  '      return { unmade: "answered_elsewhere: campaign " + String(owner.campaignId) + " answers this event", decided: "done" };',
  "    }",
  "  }",
  "",
].join("\n");

export const LEAD_CLAIM_BLOCK = [
  "  // ONE campaign converses with a lead (SCRIPT-VALUE-RATING-1113-WF1): several campaigns of the brand may answer the same",
  "  // lead (a Meeting booked path and the Lead event answer; one reply raises several events). The campaign holding the",
  "  // lead's claim answers; another one within " + ANSWER_WINDOW_MINUTES + " minutes of its last answer sends nothing.",
  "  const answerKey = s(row.leadId) || named.leadId || named.email || named.phone;",
  "  if (answerKey) {",
  '    const owner = ctx.storage.claim("answering_leads", String(answerKey), { campaignId: campaignId, at: now });',
  "    if (owner && owner.campaignId !== campaignId && Date.parse(now) - Date.parse(String(owner.at)) < " + ANSWER_WINDOW_MINUTES + " * 60000) {",
  '      must("lead.followup.record", { params: { id: row.id }, body: { kind: "stopped", reason: "answered_by_another_campaign" } });',
  '      return { unmade: "answered_elsewhere: campaign " + String(owner.campaignId) + " answers this lead", decided: "done" };',
  "    }",
  '    if (!owner || owner.campaignId !== campaignId || owner.at !== now) ctx.storage.set("answering_leads", String(answerKey), { campaignId: campaignId, at: now });',
  "  }",
  "",
].join("\n");

const GOAL_PROMPT =
  'const system = [voice.content].concat(personaBlock, K.GAME, [s(req.goal) ? "WHAT THIS ANSWER WORKS TOWARD (the campaign\'s Target):\\n" + req.goal : ""], mediumLines, [';

function once(code: string, needle: string): void {
  const n = code.split(needle).length - 1;
  if (n !== 1) throw new Error(`answerer upgrade: ${JSON.stringify(needle.trim().slice(0, 80))} found ${n} times, want exactly 1: read the stored code again`);
}

/** The answerer as of v7 (no claim, no goal) -> with the lead claim and the goal. */
export function answererWithGoalAndLeadClaim(stored: string): string {
  if (stored.includes("ctx.storage.claim(")) throw new Error("answerer upgrade: the stored code already claims");
  once(stored, CLAIM_ANCHOR);
  once(stored, PROMPT_ANCHOR);
  return stored.replace(CLAIM_ANCHOR, () => CLAIM_ANCHOR + LEAD_CLAIM_BLOCK).replace(PROMPT_ANCHOR, () => GOAL_PROMPT);
}

/** The stored v8 (event claim) -> the lead claim; the goal section v8 already reads is kept. */
export function answererV8ToLeadClaim(stored: string): string {
  once(stored, EVENT_CLAIM_BLOCK_V8);
  return stored.replace(EVENT_CLAIM_BLOCK_V8, () => LEAD_CLAIM_BLOCK);
}

/**
 * v10: a PROACTIVE run (no occurrence) answers the next due lead its campaign's brand holds (SCRIPT-VALUE-RATING-1113-WF1,
 * owner relayed: « who to write to without an event = the leads the campaign's own Plan already holds below the
 * Target; no new audience »). lead-service `POST /orgs/buffer/next` `dueFollowupOnly: true` serves ONLY a lead whose one
 * next follow-up date passed and who is owed now (never a fresh, bought or stocked lead), held one hour for this
 * campaign; the run then claims them exactly like an occurrence's person and goes on unchanged (the lead claim keeps one
 * campaign per lead). Nobody due = `nobody_due` idle. An occurrence run is byte for byte as before.
 */
export const TRIGGER_ANCHOR = '  const trigger = req.trigger && typeof req.trigger === "object" ? req.trigger : null;\n  if (!trigger) return { unmade: "no_occurrence" };\n';
export const BRAND_CAMPAIGN_ANCHOR = '  if (!brandId || !campaignId) throw new Error("the run names no brand or campaign");\n';
export const PROACTIVE_BLOCK = [
  "  // A proactive tick (no occurrence): the next lead the brand already holds whose one follow-up date passed, served to",
  "  // this campaign only (never a fresh lead) and held for its claim below (SCRIPT-VALUE-RATING-1113-WF1).",
  "  if (!trigger) {",
  '    const served = door("lead.serve", { dueFollowupOnly: true });',
  '    if (!served.ok) throw new Error("lead.serve failed: " + String(served.data && served.data.error));',
  '    if (!served.data.found || !served.data.lead) return { unmade: "nobody_due: " + String(served.data.reason || "none"), decided: "idle" };',
  "    const ld = served.data.lead;",
  '    trigger = { leadId: s(ld.leadId), person: { email: s(ld.email), phone: s(ld.phone) }, sourceTriggerId: "follow_up_due", item: { kind: "follow_up_due", note: "their follow-up date passed: nothing new happened, this is our next look" } };',
  "  }",
  "",
].join("\n");

export function answererV9ToProactive(stored: string): string {
  if (stored.includes("dueFollowupOnly")) throw new Error("answerer upgrade: the stored code already serves a proactive tick");
  once(stored, TRIGGER_ANCHOR);
  once(stored, BRAND_CAMPAIGN_ANCHOR);
  return stored
    .replace(TRIGGER_ANCHOR, () => '  let trigger = req.trigger && typeof req.trigger === "object" ? req.trigger : null;\n')
    .replace(BRAND_CAMPAIGN_ANCHOR, () => BRAND_CAMPAIGN_ANCHOR + PROACTIVE_BLOCK);
}
