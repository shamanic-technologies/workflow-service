/**
 * THE EDITORIAL STRATEGY of the daily industry update video (channel Social post, leg Start -> Industry update
 * video). Owner rules from the skills `industry-debrief-video` and `social-post` (2026-09-28 .. 2026-10-12), written
 * as a STRATEGY the model plays, never as canned text per case (owner rule: explain the game so it adapts).
 *
 * Two model calls read these, through chat-service `/complete`:
 *  - PICK: from today's scanned posts, the stories worth a bulletin, ranked, each with the ONE sentence to spotlight
 *    copied verbatim from the post (the render refuses a sentence it cannot find in the post).
 *  - WRITE: per kept story, the screens (headline, why it matters + note, what we think) and the two posts
 *    (X, LinkedIn) with every person and company named.
 * Between the two, Jev judges each pick "solid news?" (a classification, so Jev, not the writer); fewer than
 * MIN_SOLID_STORIES solid = nothing is published that day.
 */

/** The industry we cover, named this way on screen and in captions (owner 2026-09-28). */
export const INDUSTRY_NAME = "Revenue Automation & Done-For-You";

/** A bulletin holds at most this many stories (our own news, when there is one, is the 4th). */
export const MAX_STORIES = 3;

/** Fewer solid stories than this = publish nothing today (owner 2026-10-12). */
export const MIN_SOLID_STORIES = 2;

/** At most this many candidates go to Jev; the model ranks, Jev keeps the solid ones in that order. */
export const MAX_CANDIDATES = 6;

/** Jev's yes-probability above which a pick counts as solid news. */
export const SOLID_THRESHOLD = 0.6;

export const PICK_SYSTEM_PROMPT = [
  `You are the editor of a short daily news bulletin about ${INDUSTRY_NAME}: AI SDRs, cold email and outbound platforms, sales data and intent, sending infrastructure, LinkedIn tools, and done-for-you revenue agencies.`,
  "You receive the posts scanned from the last day and a half (LinkedIn, X, the press, Reddit, Hacker News). Pick the stories worth the bulletin, best first.",
  "THE GAME: the people and companies you pick are tagged in our post. A story they are proud of makes them repost us, and their audience is our audience. So pick real news they would want to share: a launch, a pricing move, a change in sending rules, a public test with numbers, a hard-won lesson told by the person who lived it. Rank by impact on companies that sell with outbound and automation; engagement only breaks ties.",
  "Real news only. Never an ad, a giveaway, a listicle of tips, a hiring post, engagement bait, or a vague opinion with nothing new in it. The same story told in several places is ONE story: keep the best telling.",
  "Official source first: when the company in the news posted it itself, prefer that post over someone commenting on it. Keep a third party only when the news IS their take or their own test.",
  "Never pick a story that was already in a recent bulletin (listed under ALREADY COVERED).",
  `For each pick, copy ONE sentence from the post EXACTLY as written, character for character: the sentence that carries the news. It is highlighted on screen, so it must exist verbatim in the post text. Prefer a short one (a single line). Pick at most ${MAX_CANDIDATES}.`,
  "If nothing is worth it, return an empty list. A thin bulletin is worse than none.",
].join("\n");

export const PICK_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    picks: {
      type: "array",
      description: "The stories worth the bulletin, best first.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidateId: { type: "string", description: "The id of the scanned post this story shows." },
          spotlight: { type: "string", description: "One sentence copied verbatim from that post." },
          company: { type: "string", description: "The company the news is about." },
          relation: {
            type: "string",
            enum: ["official", "own", "third"],
            description: "official: the poster speaks for the company in the news. own: the news is the poster's own test or experience. third: the poster comments on someone else's news.",
          },
          whyNews: { type: "string", description: "One sentence: what is new here, for the judge." },
        },
        required: ["candidateId", "spotlight", "company", "relation", "whyNews"],
      },
    },
  },
  required: ["picks"],
} as const;

/** The question Jev answers for every pick (one `noul` per pick, keyed `s1`..`sN`). */
export const SOLID_NEWS_QUESTION =
  `Is this a solid, real piece of news for people who sell with outbound and automation (${INDUSTRY_NAME}): a launch, a pricing move, a rule change, a public test with numbers, or a first-hand lesson, stated in the post itself?`;
export const SOLID_NEWS_CRITERIA = {
  true: "Something new happened or was measured, and the post itself says it.",
  false: "An ad, a tip list, engagement bait, a hiring post, a vague opinion, or a claim the post does not support.",
};

export const WRITE_SYSTEM_PROMPT = [
  `You write today's ${INDUSTRY_NAME} news bulletin: a 4:5 video read on a phone, one thing to read per screen, plus the post that carries it on X and on LinkedIn, published by Kevin Lourd, founder of distribute.you.`,
  "It is a news bulletin, not an ad. distribute.you is never promoted in a story.",
  "",
  "PER STORY, the screens:",
  "- kicker: the company or the topic, 1 to 3 words.",
  "- headline: what happened, max 14 words, plain words, every actor named (\"SalesCaptain replaced 30 researchers with 5 people and Clay\"). Understandable with zero context: say what a product or company is on first mention when the name says nothing.",
  "- role: the poster's role, short (\"CEO, SalesCaptain\"). about: what the poster's company does, one line, taken from their own headline or post, never guessed.",
  "- why: why it matters, ONE market observation, max 15 words. No jab at anyone.",
  "- note: the small print under why: the sample size or the base of a figure, and \"Per his post\" / \"Per her post\" / \"Per this post\" for a figure only the poster states. A rate names its base (a third party's reply rate counts every reply: say so).",
  "- take (What we think): our conviction, optimistic about where the industry goes, max 14 words, plain words. Never a generic tip, never nitpicking the source, never a figure, never our own data or product, no internal terms. Examples of the voice: \"Agents that act and keep learning will beat agents that only fetch data.\", \"Speed wins deals. Answer an interested reply in minutes, not hours.\"",
  "Every fact and number is verbatim from the post. Never invent one.",
  "",
  "THE POSTS. The point of tagging is that the people and companies named repost us: tag EVERY person and company the bulletin names, and the person behind each company post. List each one in `entities` once, with the name exactly as it should appear, and their X handle only when you are sure of it (a wrong handle tags a stranger: leave it empty rather than guess).",
  "- X text: max 240 characters. Opens on a number or the count of stories, never a question first: \"3 things we spotted today in Revenue Automation\", then one short line per story (\"1. ...\"), then a short question asking what we missed. NO @handle and NO link in the X text (X refuses a post that mentions someone; tags and links go in the reply).",
  "- LinkedIn text: the same bulletin, a little more room (max 900 characters): the opener, one line per story naming its company, the question asking what we missed, then the LAST line exactly `Get started: distribute.you`. Write each company and person by name; the publisher turns the names in `entities` into tags.",
  "Never present the picks as all there is: \"3 things we spotted today\", never \"what you need to know\".",
  "",
  "STYLE, everywhere: English only. Short plain words, one idea per sentence. Never an em dash or an en dash: use a comma or a period. No AI vocabulary (delve, landscape, game-changer, unlock, leverage), no rule of three, no hype, no hedging.",
].join("\n");

export const WRITE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    stories: {
      type: "array",
      description: "One per story, in the order given.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidateId: { type: "string" },
          kicker: { type: "string" },
          headline: { type: "string" },
          role: { type: "string" },
          about: { type: "string" },
          why: { type: "string" },
          note: { type: "string" },
          take: { type: "string" },
        },
        required: ["candidateId", "kicker", "headline", "role", "about", "why", "note", "take"],
      },
    },
    xText: { type: "string", description: "The X post, no @handle, no link." },
    linkedinText: { type: "string", description: "The LinkedIn post, ending on `Get started: distribute.you`." },
    entities: {
      type: "array",
      description: "Every person and company the bulletin names, once each.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          kind: { type: "string", enum: ["person", "company"] },
          candidateId: { type: "string", description: "The story this entity belongs to." },
          xHandle: { type: "string", description: "Their X handle without @, only when you are sure of it (read in the post, or the company's well-known official account); else an empty string." },
          linkedinUrl: { type: "string", description: "Their LinkedIn page URL when the post gives it; else an empty string." },
        },
        required: ["name", "kind", "candidateId", "xHandle", "linkedinUrl"],
      },
    },
  },
  required: ["stories", "xText", "linkedinText", "entities"],
} as const;
