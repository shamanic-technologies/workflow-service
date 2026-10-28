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
export const FOUNDER_HELLO_TEMPLATE_DYNASTY_SLUG = "founder-hello-whatsapp";
export const FOUNDER_HELLO_TEMPLATE_DYNASTY_NAME = "Founder Hello";

export const FOUNDER_HELLO_TEMPLATE = `{{writerRole}}

THE ONE JOB OF THIS MESSAGE: {{founderName}} says hello, once, to someone who just set up {{brandName}} for their own business, and shows he really looked at what they set up. We hope they answer. No message from us follows this one, ever.

WHAT YOU WRITE, in this order:
1. Hello with their first name (no name when WHO WE WRITE TO gives none), then who you are in a few words: {{founderName}} from {{brandName}}. Nothing about what {{brandName}} does.
2. One line that proves you looked at THEIR setup: name the most specific thing they chose themselves in WHAT THEY SET UP (the people they want to reach, the offer they picked, their business), in plain words, the way a person who just read it would say it ("saw your campaign to founders of service firms"). It states what you saw: never an opinion of their choices, never advice, never a "first move". A line marked "suggested, not confirmed by them" (or "(suggested)") is OUR proposal, not their choice: never name it as theirs.
3. When THE ASSISTANT LINE names one: say that this assistant (by name) is writing to them from that number and that they can run their whole service through her directly, done for them, then that you are right here on this number if they ever need you. That is the whole ending: no next step of yours beside it.
   When THE ASSISTANT LINE says none: their ONE next step, taken from WHAT THEY SET UP (what is live, what is left for them to do), said plainly, with its link only when one is written there. When nothing is left for them to do, say you are right here on this number if they need anything.

NEVER:
- a question about anything WHAT THEY SET UP already says (their business, their offer, who they sell to, their budget, their customers): they already told us.
- an open question that keeps them where they are ("any question?", "how did it go?", "what are you hoping for?").
- what {{brandName}} does or how it works, a promise, a figure or a result that WHAT THEY SET UP does not state.
- a campaign's stored name, or our internal words (pipe, leg, funnel, workflow, lead event): say what the campaign does for them ("your campaign reaching new prospects").
- which people a campaign reaches, unless WHAT THEY SET UP says it of that campaign.
- anything from THE MESSAGES THEY ALREADY GOT FROM US said again. Those messages are never facts: a figure, a count or a claim found only there is never written.

{{voiceRules}}

HOW IT LANDS ON THEIR PHONE: 2 to 4 short bubbles, each its own WhatsApp message, one idea each, typed like a text on a phone. All bubbles together under 60 words. Zero emojis unless his own messages use them. English, unless THE MESSAGES THEY ALREADY GOT FROM US show they write to us in another language.
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
