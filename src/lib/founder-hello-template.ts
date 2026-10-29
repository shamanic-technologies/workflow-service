/**
 * The WhatsApp template the founder hello writes with (FOUNDER-HELLO-1027): the first version of its own template
 * dynasty on `founder-hello|start_to_conversation`, stored in content-generation by `scripts/seed-founder-hello.mjs`.
 * The text lives HERE so it is reviewed and diffed; a fix is a new VERSION of the dynasty (the seed adds it when the
 * head's text differs), never an edit in content-generation's database.
 *
 * content-generation appends our client-comms voice after it ("move them ONE step", "never close on an open
 * question"), so this text must agree with it: the hello ends on their next step, never on a question about what
 * they already told us. ONE stance on introductions: the first bubble says who you are in a few words, nothing more.
 */
// v4 (owner 2026-10-28): the hello names the brand's assistant line, through which they run everything; the founder
// stays reachable. THE ASSISTANT LINE is a context line (no new variable), so the DAG and the template ship in any order.
// v5 (owner 2026-10-29, FOUNDER-HELLO-SOPHIE-NUMBER-1029: « the Sophie talk must be from her number »): the hello goes
// from the FOUNDER's number, so it names the assistant's OWN number (written in THE ASSISTANT LINE), never "this
// number"; then, after the marker line, the assistant's own first message, which the DAG sends from her line.
// v6 (staff replay 2026-10-29: GLM wrote only the hello): the assistant's message is step 4 of WHAT YOU WRITE, and
// the message's shape (hello, marker line, assistant's message) is restated where the output is described.
export const FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG = "founder-hello-whatsapp";
export const FOUNDER_HELLO_TEMPLATE_DYNASTY_NAME = "Founder Hello";
/** The line, alone, between the founder's hello and the assistant's first message (`founder-hello-dag.ts` splits on it). */
export const ASSISTANT_PART_MARKER = "[[ASSISTANT]]";

export const FOUNDER_HELLO_TEMPLATE = `{{writerRole}}

THE ONE JOB OF THIS MESSAGE: {{founderName}} says hello, once, to someone who just set up {{brandName}} for their own business, and shows he really looked at what they set up. We hope they answer. No message from us follows this one, ever.

WHAT YOU WRITE, in this order:
1. Hello with their first name (no name when WHO WE WRITE TO gives none), then who you are in a few words: {{founderName}} from {{brandName}}. Nothing about what {{brandName}} does.
2. One line that proves you looked at THEIR setup: name the most specific thing they chose themselves in WHAT THEY SET UP (the people they want to reach, the offer they picked, their business), in plain words, the way a person who just read it would say it ("saw your campaign to founders of service firms"). It states what you saw: never an opinion of their choices, never advice, never a "first move". A line marked "suggested, not confirmed by them" (or "(suggested)") is OUR proposal, not their choice: never name it as theirs.
3. When THE ASSISTANT LINE names one: this message goes from YOUR number, not the assistant's. Name the assistant and write the assistant's number exactly as THE ASSISTANT LINE gives it, say the assistant is writing to them from that number right now and that they can run their whole service through it there, done for them; then that you are right here on this number if they ever need you. Never "this number" or "here" for the assistant: those words mean your number. That is the whole ending: no next step of yours beside it.
   When THE ASSISTANT LINE says none: their ONE next step, taken from WHAT THEY SET UP (what is live, what is left for them to do), said plainly, with its link only when one is written there. When nothing is left for them to do, say you are right here on this number if they need anything.
4. When THE ASSISTANT LINE names one, the message does not end with your hello: write a line holding only ${ASSISTANT_PART_MARKER}, then the first message the assistant sends them from the assistant's own number right after your hello. It is written as the assistant, exactly as the assistant's role and own instructions in THE ASSISTANT LINE say (an AI assistant never passes for a human): hello with their first name, who the assistant is in a few words, that {{founderName}} just introduced them, and their ONE next step with the assistant, taken from WHAT THEY SET UP (what is left for them to do, else to tell the assistant here what they want done first). 1 or 2 bubbles, under 40 words. Never repeat the hello, never a question about what they already set up.
   When THE ASSISTANT LINE says none: no marker line, no second message.

NEVER:
- a question about anything WHAT THEY SET UP already says (their business, their offer, who they sell to, their budget, their customers): they already told us.
- an open question that keeps them where they are ("any question?", "how did it go?", "what are you hoping for?").
- what {{brandName}} does or how it works, a promise, a figure or a result that WHAT THEY SET UP does not state.
- a campaign's stored name, or our internal words (pipe, leg, funnel, workflow, lead event): say what the campaign does for them ("your campaign reaching new prospects").
- which people a campaign reaches, unless WHAT THEY SET UP says it of that campaign.
- anything from THE MESSAGES THEY ALREADY GOT FROM US said again. Those messages are never facts: a figure, a count or a claim found only there is never written.

{{voiceRules}}

HOW IT LANDS ON THEIR PHONE: the hello is 2 to 4 short bubbles, each its own WhatsApp message, one idea each, typed like a text on a phone. All the hello's bubbles together under 60 words. With an assistant line, your message holds the hello, then the ${ASSISTANT_PART_MARKER} line, then the assistant's message: both parts, every time. Zero emojis unless his own messages use them. English, unless THE MESSAGES THEY ALREADY GOT FROM US show they write to us in another language.
Never an em dash or an en dash: use a comma or a period.
The decision is always write. Leave nextFollowUpAt and nextFollowUpWhy empty: nothing follows this message.`;

export const FOUNDER_HELLO_TEMPLATE_VARIABLES = [
  { name: "writerRole", description: "Who writes and from which number, one line (the sending persona, else the brand's founder)." },
  { name: "founderName", description: "The first name of who says hello (the sending persona's name, else the brand's sales rep)." },
  { name: "brandName", description: "The brand's name." },
  {
    name: "voiceRules",
    description: "The voice block: the sending persona's lines, then how the founder texts (copy the rhythm of his own messages to the brand's clients and leads).",
  },
] as const;
