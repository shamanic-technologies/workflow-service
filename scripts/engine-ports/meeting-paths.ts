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
 * Answers: the answerer's own result (`{content: {answered}}`); its `unmade` (+ `decided`) forwarded word for word, as
 * `dy_answer_lead_pull` does; no occurrence = `unmade no_occurrence`. A missing `goal` throws: no default goal in code.
 */
import { PORT_HEAD } from "./port-kit.js";

const COMMON = {
  // No tactic `channel`: the outcome says WHAT (MIGRATE-1105 S5), so a campaign launched on its Target alone (no channel)
  // finds the path. A client's own-team channel (`your-team-*`, operated by the customer) is never dispatched to any
  // script, so it never runs this one.
  asks: ["message_sent"],
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
    "Works toward a booked meeting: when a lead writes or acts, asks for the one answer that proposes a meeting with open times or the booking link, and books the time they pick.",
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
    "Works toward an attended meeting: when a lead books or acts, asks for the one answer that reminds them of their meeting shortly before it starts, in their timezone.",
} as const;

export function buildMeetingPathSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** A path toward a meeting outcome: asks the answerer for the one answer, with this script's goal (SCRIPT-VALUE-RATING-1113-WF1). */`,
    PORT_HEAD,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request;
  if (!R || !R.trigger) return { unmade: "no_occurrence" };
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
 *   1. ONE answer per trigger event: right after its person claim, an occurrence run claims the event for its campaign
 *      in the Engine's storage (`ctx.storage.claim`, atomic: the first campaign wins). A second campaign answering the
 *      same event (a Meeting booked path and the Lead event answer of one brand) sends nothing, rings no rep, closes its
 *      own queue row (never the person: the winner leaves their one next date) and ends `decided: done`.
 *   2. The asking script's goal, when the Request states one, reaches the writer as one prompt section; none = the
 *      prompt byte for byte.
 */
export const EVENT_CLAIM_ANCHOR = "  const row = claim.followup;\n";
export const PROMPT_ANCHOR = "const system = [voice.content].concat(personaBlock, K.GAME, mediumLines, [";

export function answererWithGoalAndEventClaim(stored: string): string {
  if (stored.includes("ctx.storage.claim(")) throw new Error("answerer upgrade: the stored code already claims its event");
  for (const a of [EVENT_CLAIM_ANCHOR, PROMPT_ANCHOR]) {
    const n = stored.split(a).length - 1;
    if (n !== 1) throw new Error(`answerer upgrade: anchor ${JSON.stringify(a.trim())} found ${n} times, want exactly 1: read the stored code again`);
  }
  const claim = [
    EVENT_CLAIM_ANCHOR.trimEnd(),
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
  const prompt =
    'const system = [voice.content].concat(personaBlock, K.GAME, [s(req.goal) ? "WHAT THIS ANSWER WORKS TOWARD (the campaign\'s Target):\\n" + req.goal : ""], mediumLines, [';
  return stored.replace(EVENT_CLAIM_ANCHOR, claim).replace(PROMPT_ANCHOR, prompt);
}
