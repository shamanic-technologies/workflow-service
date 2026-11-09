/**
 * The answering strategies the lead-answering script (`scripts/answer-lead-script.ts`) states word for word, kept from
 * the follow-up workflow (MIGRATE-1105 S7: that workflow's DAG builders moved into `scripts/engine-ports/`).
 */

/**
 * A NEW FACT decides the next date again (MEETING-REMINDER-1103, owner 2026-11-03: a prospect booked a meeting for the
 * next day and the Lead event run kept a date stated before the booking, 3 weeks out). A strategy the writer plays,
 * never a branch on an event type. Dash-free: the model copies the style of its prompt.
 */
export const NEW_FACT_STRATEGY =
  "A NEW FACT DECIDES AGAIN. A next date stated before what just happened (by us, by another campaign, by an earlier " +
  "look) holds nothing: decide the next date now, from everything the thread, the events and the event below say. " +
  "When they booked a meeting with us, the goal is that they come to it: the next message is a short, friendly " +
  "reminder before the meeting starts (the day before or a few hours before, at a sensible hour in their timezone), " +
  "naming the day and time of the meeting in their timezone, in the thread where they last wrote. Write it now only " +
  "when now is that moment; otherwise set decision to later with nextFollowUpAt before the meeting starts, never " +
  "after it. Nothing pushy: no new pitch, nothing they must answer. Say in nextFollowUpWhy that it is the reminder " +
  "for that meeting.";

/**
 * WHAT ONLY THE TEAM DECIDES (ZARINA-WRITER-INVENTED-1104, owner 2026-11-04: a paying client asked Kevin for "the
 * details and options on how to move forward"; the writer answered as Kevin with a plan, a status nobody gave it and a
 * yes to her sample idea). A strategy, never a keyword rule: the model judges what is the team's call; the team is
 * told (the rep alert) and answers itself.
 */
export const TEAM_DECIDES_STRATEGY =
  "WHAT ONLY THE TEAM DECIDES. Some answers are not yours to give, even when the thread seems to hold pieces of them: " +
  "a proposal, a plan or options for their account, a price, a budget or terms for them, a yes or a no to something " +
  "they propose (a sample, a discount, a condition), a change to anything already agreed, and anything a person of our " +
  "team promised to send or do for them personally. The same when they refer to something you cannot read here (a call, " +
  "another conversation, a document). When their last message asks for one of these, or the thread shows they are " +
  "waiting for one from us, set decision to escalate: write nothing to them, put what they asked in question, in their " +
  "words, and say in reason what the team must decide. The team answers them itself, with what it knows and you do not.";

/**
 * WHEN THEY ALREADY USE SOMEONE ELSE (COMPETITOR-FIRST-1105, owner 2026-11-05: a lead wrote he is testing another
 * vendor "and getting good success"; « faudrait comprendre son $/meeting booked chez Explee, ou lui demander ce qui
 * lui manque chez eux, pour savoir si on peut faire quelque chose »). A strategy, never a rule keyed on a vendor name:
 * the model judges whether they named someone else; when they did not, nothing here applies. Dash-free.
 */
export const COMPETITOR_FIRST_STRATEGY =
  "WHEN THEY ALREADY USE SOMEONE ELSE. When they say they already use, test or work with another company, tool or " +
  "team for what we offer, a pitch is wasted: someone fully happy there has no reason to switch, and only what is " +
  "missing there makes us worth their time. So learn before you sell. Ask ONE short, friendly question that finds out " +
  "whether it fully works for them: what one result costs them there, in the unit of what we offer (per meeting " +
  "booked, per client, per lead), or what they miss with it. That question is the next step of their path and the one " +
  "question the message ends on: no comparison yet, no list of what we do better, no call or link to push. Once they " +
  "answer, compare their result with what the FACTS say we can do for that result, and propose the step that fits only " +
  "if we do better. When they also asked us to stop, it is a stop like any other. When they say our product or offer " +
  "was hard to understand or to start, own it in one plain sentence, never defend it and never make it their fault, " +
  "and offer the easiest way in that the FACTS or the thread hold (we set it up for them, when the FACTS say we do). " +
  "When they name no one else, none of this applies: never ask who they use.";
