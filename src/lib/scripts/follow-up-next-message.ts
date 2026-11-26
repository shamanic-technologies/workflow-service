/**
 * PERSON-ALREADY-EMAILED-1125, the writer half (owner rule FOLLOWUP-JIT 2026-11-07: a person the brand already emailed
 * gets a follow-up in their thread, never a new cold introduction). The lead follow-up writer
 * (`message_written/dy_follow_up_due`) re-pitched people we had emailed seven times as if they never heard of us (prod,
 * 7 days to 2026-11-25: 4 of 5 sampled « follow-ups » opened « We run sales cold email for you, end to end… »).
 * The sentence that licensed it: « Each message must earn a reply on its own … Never a reminder of an earlier
 * message ». Restated as the principle it serves (owner rule: fix an LLM step by its instruction, never a check or
 * retry on its output): the message is the NEXT one of the conversation the thread shows; what we told them stands and
 * is never said again as news. « Never "just following up" » stays. Anchored edit of the STORED code; a moved anchor
 * = nothing generated.
 */
const MARK = "PERSON-ALREADY-EMAILED-1125";
// As stored: a JS string literal, its quotes escaped.
const LICENCE =
  'Each message must earn a reply on its own: written NOW, for where this person stands NOW, from what they last said and did. Never a reminder of an earlier message, never \\"just following up\\" or \\"bumping this\\".';
const PRINCIPLE =
  'Each message is the NEXT one of the conversation THE THREAD shows, written NOW for where this person stands NOW, from what they last said and did. What we already told them stands and is never said again as news: never introduce us, what we do or our offer as if they had never heard of it; bring one thing they do not have yet. Never \\"just following up\\" or \\"bumping this\\".';

// The email line stated an envelope that is not always true (« a reply … from the same mailbox »): the follow-up
// continues the thread only while that thread's mailbox still sends; otherwise it arrives as a NEW email from someone of
// our team they have not heard from (owner 2026-11-26, option B: keep sending). Before writing, nothing tells which one
// (instantly-service picks the mailbox at send), so the writer is told both are possible, never a guess.
const ENVELOPE = "the email is a reply in the last email thread we have with them, from the same mailbox, so never re-introduce us.";
const ENVELOPE_TRUE =
  "the email continues our last email thread with them when the mailbox of that thread still sends; otherwise it arrives as a new email from someone of our team they have not heard from yet. Write it so it reads right either way: our team following up on our earlier notes, never one person's own promise or memory, never a re-introduction of us.";

export function addFollowUpNextMessage(code: string): string {
  if (code.includes(MARK)) throw new Error("follow-up next message: already in the code");
  if (code.split(LICENCE).length !== 2) throw new Error("follow-up next message: the licensing sentence is not found exactly once");
  if (code.split(ENVELOPE).length !== 2) throw new Error("follow-up next message: the email envelope line is not found exactly once");
  return code.replace(LICENCE, PRINCIPLE).replace(ENVELOPE, ENVELOPE_TRUE).replace(/^/, `// ${MARK}: a follow-up is the next message of the thread, never a re-introduction.\n`);
}
