#!/usr/bin/env node
/**
 * Ops script: the website-visit twin of `fork-yc-cold-email.mjs` (owner,
 * 2026-10-05). Ships `yc-cold-email-click-v1` as a NEW dynasty on
 * `sales-cold-email-outreach` and puts it on the Scout leg
 * (`start_to_website_visit`, outcome = human website visit) beside the
 * workflows already there.
 *
 * The template is written ONLY from Y Combinator's cold-email advice, aimed at
 * the click instead of the reply: three sentences, the client's exact link
 * alone on the last line of every email, never a meeting or reply ask. Its
 * variables are those of `cold-email-v35`, the best template on Scout by cost
 * per visit on the Research page snapshot of 2026-10-03.
 *
 * Source: the active head of `sales-cold-email-outreach-rampart`, the best
 * Scout workflow on that snapshot. Its content call maps all nine v35 tokens
 * (`brandWebsiteUrl` is the brand's `clickDestinationUrl`). Model stays
 * `flash`, the alias rampart runs, which chat-service resolves to
 * `gemini-3.5-flash-lite` (Gemini 3.5 Flash-Lite, Scout's best model).
 *
 * Mechanics, checks and idempotence are `runFork` in `fork-yc-cold-email.mjs`;
 * copy BOTH files next to each other before running.
 *
 * Usage (inside the workflow-service container, against dist):
 *
 *   node fork-yc-cold-email-click.mjs --org <uuid>
 *   node fork-yc-cold-email-click.mjs --org <uuid> --apply
 *   [--dynasty <source dynasty slug>]
 */

import { pathToFileURL } from "node:url";
import { runFork, buildTemplateFor, withTemplateFor } from "./fork-yc-cold-email.mjs";

export const LEG_KEY = "start_to_website_visit";
export const TEMPLATE_TYPE = "yc-cold-email-click-v1";
export const DESCRIPTION_SOURCE_TYPE = "cold-email-v35";
export const MODEL = "flash";
export const DEFAULT_SOURCE_DYNASTY = "sales-cold-email-outreach-rampart";
export const LEG_NOTE =
  "Owner decision 2026-10-05: YC website-visit cold-email template (yc-cold-email-click-v1) on Gemini 3.5 Flash-Lite, A/B beside the leg's other workflows.";

export const WORKFLOW_DESCRIPTION =
  "Website-visit cold-email sequence written only from Y Combinator's cold-email advice: three sentences (what the " +
  "client does, best proof, explicit ask), the exact client link alone on the last line of every email, never asks " +
  "for a meeting or a reply, no backstory or flattery, casual subject, two short follow-ups. Variables from " +
  "cold-email-v35, runs on Gemini 3.5 Flash-Lite.";

/** Owner-approved text (2026-10-05), stored verbatim. */
export const TEMPLATE_PROMPT = `You're writing a 3-email cold sequence on behalf of a client. You name the client and say what they do. Every email has one goal: the prospect clicks the client's link.

## Email 1: three sentences
Each sentence sits on its own line, separated by a blank line. The prospect reads it in under 60 seconds.
1. What the client does, by name, in plain words. Zero jargon, no adjectives piled on.
2. Why it matters to this prospect, led by the best proof in the brand intel: a named customer, a result, a launch, growth, a known backer. A real name beats any adjective.
3. The ask, explicit: one short line that tells them what they will see, then the link alone on the last line.

Open with "Hi {{leadFirstName}}," on its own line. No sign-off line: the signature is added after.

## The link
The link is {{brandWebsiteUrl}}, written exactly as given, with every path and parameter. Never shorten it to the domain. It sits alone on its own line, as the last line of every email.

## The ask
Never ask for a meeting, a call, a demo or a reply. The only ask is the click. Let them escalate.

## Make it about them
Their problem, in the words someone in their job would use. Find one real reason it is them and not a thousand others: something specific in their title, company, industry or size. If nothing real stands out, do not fake one. A sentence that could go to 1,000 prospects unchanged is cut.

## What to leave out
- Backstory: no history of the client, no awards, no "founded in", no origin story.
- Flattery: no compliments on the prospect, their company, their role or their posts.
- Any word that does not serve the click.

## Voice
Write like you talk to a friend. Read it out loud in your head: if it sounds like marketing or like an AI, rewrite it. No em dashes, no en dashes.

## Subject (email 1 only)
Two to five words, casual and relevant, like a friend wrote it. Not marketing.

## Follow-ups
Emails 2 and 3 go in the same thread (no new subject), about 3 days and about 7 days later. Each is one or two sentences: one new reason to look (a fresh proof or angle from the brand intel), then the link alone on the last line. Never restate email 1. Never "just bumping" or "did you see my email".

## Honesty floor
Use only what's in the brand profile and brand intel. Don't invent results, customer names, backers or urgency. If a sentence would require making something up, cut it.

## Data hygiene
Apollo data comes in weird shapes: ALL CAPS company names, outdated employee counts. Normalize names to title case. Skip weak signals that would sound robotic.

---

Now write the sequence for:

## Prospect
- Name: {{leadFirstName}} {{leadLastName}}
- Title: {{leadTitle}}
- Company: {{leadCompanyName}}
- Industry: {{leadCompanyIndustry}}
- Company Size: {{leadCompanySize}}

## Client Brand Profile
{{brandProfile}}

## Brand Intelligence
{{brandExtractedFields}}

## Client Link
{{brandWebsiteUrl}}

Output: the three emails, ready to send. Nothing else.`;

export const SPEC = {
  templateType: TEMPLATE_TYPE,
  templatePrompt: TEMPLATE_PROMPT,
  descriptionSourceType: DESCRIPTION_SOURCE_TYPE,
  model: MODEL,
  defaultSourceDynasty: DEFAULT_SOURCE_DYNASTY,
  legKey: LEG_KEY,
  legNote: LEG_NOTE,
  workflowDescription: WORKFLOW_DESCRIPTION,
};

export const buildTemplate = (descriptionSource) => buildTemplateFor(SPEC, descriptionSource);
export const withYcClickColdEmail = (dag) => withTemplateFor(SPEC, dag);

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFork(SPEC);
}
