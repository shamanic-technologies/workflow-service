#!/usr/bin/env node
/**
 * TPL-DYNASTY-1021-WF (4) — the first template fixes, each a NEW HEAD VERSION of its dynasty in content-generation
 * (`POST /internal/template-dynasties/{slug}/versions`): the template TEXT is fixed, never an output check, never a
 * fork. Every workflow reading the dynasty writes with it on its next run.
 *
 *   a. cold-reply-free-offer-blind: the head becomes `blind-discovery-email-v47-spaced` (stored 2026-10-21 before
 *      dynasties existed, mebsuta already runs it): attached as-is (`{type}`), short spaced paragraphs.
 *   b. cold-reply-free-offer-named: the email reads ALL the client's information, the offer's "gives for free" and
 *      "will NEVER give" lists included, and NAMES the client (its head said "never reveal the client name").
 *   c. cold-reply-contrarian-opener-named, cold-click-contrarian-opener-named: the email names the client (the head
 *      said "keeping the client anonymous increases conversion", leaving it to the model).
 *   +  every other dynasty head with no spacing rule gets `SPACING_BLOCK` (owner 2026-10-16: paragraphs are an
 *      obvious rule for every template).
 *
 * Every edit is anchored (a missing anchor throws, never a half-edit). content-generation refuses a text that quotes
 * one company (TEMPLATE_NOT_NEUTRAL): the illustrative examples many heads carry are neutralised the same way as
 * scripts/space-template-heads.mjs. Idempotent: a head already carrying a fix is skipped.
 *
 * Usage (inside the workflow-service container):
 *   node scripts/template-dynasty-heads-1021.mjs            # dry run: prints each new head's diff size
 *   node scripts/template-dynasty-heads-1021.mjs --apply
 * Env: CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY
 */

import { pathToFileURL } from "node:url";
import { SPACING_BLOCK, edit } from "./upgrade-no-url-sequences.mjs";
import { GREETING_LINE } from "./space-template-heads.mjs";

export const PIPES = [
  ["sales-cold-email-outreach", "lead_found_to_conversation"],
  ["sales-cold-email-outreach", "lead_found_to_website_visit"],
  ["feedback-request-cold-email-outreach", "lead_found_to_conversation"],
];

export const SPACED_FREE_OFFER_BLIND = "blind-discovery-email-v47-spaced";
const SPACING_MARKER = "## Short, spaced paragraphs, in every email";

/** Illustrative examples quoting one company, figure or person, neutralised (applied when present). */
export const NEUTRAL_REWRITES = [
  [/Example: "72% of enterprise teams are rolling back AI tools within 6 months[\s\S]*?relevant\?"/, `Example: "[A true, sharp fact about their industry], and your team just\n[a visible trigger: a hiring spike, a funding round, a launch]. We helped [Similar Company]\n[a real result from the brand intel]. Worth a quick look to see if relevant?"`],
  [/Example: "Compliance teams face 3x more regulation since 2022[\s\S]*?6 weeks to 3 days\."/, `Example: "[Their kind of team] faces [a real, growing pressure], most\nstill handle it [the old way]. Saw [Company] just [a trigger]. We built\n[what the client does, in plain words]. Your [relevant role] might want to see how [Similar Company] [a real result]."`],
  [/Example: "Just finished our Q1 2026 benchmark across 2,400 SaaS companies on churn reduction[^"]*"/, `Example: "Just finished a benchmark across [businesses like theirs] on [the topic the client knows best], your segment shows a pattern I haven't seen published anywhere. Happy to share the data + walk through how it maps to [Company]'s growth stage."`],
  [/"Helped\nStripe reduce churn 40%" lands harder than "a leading customer success platform\."/, `"Helped\n[a named customer] [a measured result]" lands harder than "a leading platform."`],
  [/"Sarah Chen, our Head of AI \(ex-Stripe, built their fraud detection system\) can walk you through how this maps to your stack"/, `"[A named teammate], our [role] ([a credential that matters to them]) can walk you through how this maps to your stack"`],
  [/They come from Apollo and might be outdated\./, "They come from a data provider and might be outdated."],
];

export function neutralise(prompt) {
  let out = prompt;
  for (const [re, to] of NEUTRAL_REWRITES) out = out.replace(re, () => to);
  return out;
}

/**
 * The dynasties the spacing rule goes to: every one an ACTIVE workflow writes with (owner-validated mapping,
 * 2026-10-21). A dynasty no workflow runs is left alone.
 */
export const SPACED_DYNASTIES = [
  "cold-click-website-click-named", "cold-reply-free-offer-named", "cold-reply-intro-offer-blind", "cold-reply-observation-named",
  "cold-click-page-click-named", "cold-click-recommendation-stack-named", "cold-click-brand-first-stack-named",
  "cold-reply-three-line-reply-named", "cold-click-three-line-click-named", "cold-reply-contrarian-opener-named",
  "cold-reply-website-click-named", "cold-click-brand-first-link-named", "feedback-reply-feedback-gift-blind",
  "feedback-reply-feedback-gift-named", "feedback-reply-diagnosis-gift-named", "cold-click-intro-offer-blind",
  // 4c names it explicitly, though no workflow runs it today.
  "cold-click-contrarian-opener-named",
];

/**
 * Dynasties whose signature rules out a greeting line ("No greeting", a stack of one-line beats, exactly three lines):
 * they get the spacing rule WITHOUT the greeting line, so the fix respects what makes the dynasty unique.
 */
export const NO_GREETING_LINE = new Set([
  "cold-click-recommendation-stack-named",
  "cold-click-brand-first-stack-named",
  "cold-click-brand-first-link-named",
  "cold-reply-three-line-reply-named",
  "cold-click-three-line-click-named",
]);

/** SPACING_BLOCK (+ the greeting line unless the dynasty rules one out) before the input section (last `---`), once. */
export function withSpacing(prompt, { greeting = true } = {}) {
  if (prompt.includes(SPACING_MARKER)) return prompt;
  const at = prompt.lastIndexOf("\n---\n");
  if (at === -1) throw new Error("no `---` input separator to place the spacing rule before");
  return `${prompt.slice(0, at)}\n\n${SPACING_BLOCK}${greeting ? `\n\n${GREETING_LINE}` : ""}\n${prompt.slice(at)}`;
}

export const READ_ALL_CLIENT_INFO = `## Read everything the client told us
Read ALL the client's information before writing: the brand intelligence below AND, when it is there, the section "What the sender offers" with its two lists. The gift you offer comes FIRST from its list of what the sender gives for free (pick the one that fits this prospect best, described exactly as stated). Only when that list is empty, use the free offering ideas above. Nothing from its list of what the sender will NEVER give appears in any email, not in whole, not in part, not as a trial or as a possibility.`;

export const NAMES_THE_CLIENT = `## The client is named
Every email names the client by its brand name, in plain words, at least once in email 1, where it fits naturally. The prospect always knows who the email is for.`;

/** b. Named Free Offer: reads all the client's info (give lists included) and names the client. */
export function buildNamedFreeOffer(prompt) {
  let p = edit(prompt, "## Brand Intelligence (internal only — never reveal the client name or URL)", "## Brand Intelligence (the client, named in the email)");
  p = edit(p, "\n---\n\nNow write the sequence for:", `\n${READ_ALL_CLIENT_INFO}\n\n${NAMES_THE_CLIENT}\n\n---\n\nNow write the sequence for:`);
  return p;
}

/** c. Contrarian Opener (named): the identity-protection line licensed an anonymous email in a named dynasty. */
export function buildNamedContrarian(prompt) {
  return edit(
    prompt,
    "## Identity protection\nKeeping the client anonymous increases most of the time conversion.\n",
    "## The client is named\nEvery email names the client ({{clientCompanyName}}) in plain words, at least once in email 1, where it fits naturally. The prospect always knows who the email is for.\n",
  );
}

export const FIXES = {
  "cold-reply-free-offer-named": { marker: "## Read everything the client told us", build: buildNamedFreeOffer },
  "cold-reply-contrarian-opener-named": { marker: "## The client is named", build: buildNamedContrarian },
  "cold-click-contrarian-opener-named": { marker: "## The client is named", build: buildNamedContrarian },
};

/** The new head text for one dynasty, or null when its head already carries every fix. */
export function planHead(slug, headPrompt) {
  const fix = FIXES[slug];
  let p = headPrompt;
  if (fix && !p.includes(fix.marker)) p = fix.build(p);
  if (SPACED_DYNASTIES.includes(slug)) p = withSpacing(p, { greeting: !NO_GREETING_LINE.has(slug) });
  if (p === headPrompt) return null;
  return neutralise(p);
}

async function call(method, path, body) {
  const { CONTENT_GENERATION_SERVICE_URL: CG, CONTENT_GENERATION_SERVICE_API_KEY: K } = process.env;
  const res = await fetch(`${CG}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": K },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

async function run() {
  const APPLY = process.argv.includes("--apply");
  const failures = [];

  // a. Attach the stored spaced Blind Free Offer as its dynasty's head.
  const fob = await call("GET", "/internal/template-dynasties/cold-reply-free-offer-blind");
  if (fob.status !== 200) throw new Error(`cold-reply-free-offer-blind: ${fob.status}`);
  if (fob.body.head === SPACED_FREE_OFFER_BLIND) console.log(`cold-reply-free-offer-blind: head already ${SPACED_FREE_OFFER_BLIND}`);
  else if (!APPLY) console.log(`cold-reply-free-offer-blind: would attach ${SPACED_FREE_OFFER_BLIND} as head (was ${fob.body.head})`);
  else {
    const r = await call("POST", "/internal/template-dynasties/cold-reply-free-offer-blind/versions", { type: SPACED_FREE_OFFER_BLIND });
    if (r.status !== 201) failures.push(`cold-reply-free-offer-blind: ${r.status} ${JSON.stringify(r.body).slice(0, 600)}`);
    else console.log(`cold-reply-free-offer-blind: head is now ${r.body.template.type}`);
  }

  for (const [featureSlug, legKey] of PIPES) {
    const list = await call("GET", `/internal/template-dynasties?featureSlug=${featureSlug}&legKey=${legKey}`);
    if (list.status !== 200) throw new Error(`dynasties ${featureSlug}|${legKey}: ${list.status}`);
    for (const d of list.body.dynasties) {
      if (d.slug === "cold-reply-free-offer-blind") continue;
      try {
        const head = await call("GET", `/internal/template-dynasties/${d.slug}/head`);
        if (head.status !== 200) throw new Error(`head ${head.status}`);
        const prompt = planHead(d.slug, head.body.template.prompt);
        if (!prompt) {
          console.log(`${d.slug}: head ${head.body.template.type} already carries every fix`);
          continue;
        }
        const delta = prompt.length - head.body.template.prompt.length;
        if (!APPLY) {
          console.log(`${d.slug}: would add a head after ${head.body.template.type} (${delta >= 0 ? "+" : ""}${delta} chars${FIXES[d.slug] ? ", fix " + d.slug : ", spacing"})`);
          continue;
        }
        const r = await call("POST", `/internal/template-dynasties/${d.slug}/versions`, {
          prompt,
          // Exactly the {{tokens}} the text uses (content-generation refuses a declared-but-unused one; dropping is fine).
          variables: head.body.template.variables.filter((v) => prompt.includes(`{{${v.name}}}`)),
        });
        if (r.status !== 201) failures.push(`${d.slug}: ${r.status} ${JSON.stringify(r.body).slice(0, 1500)}`);
        else console.log(`${d.slug}: new head ${r.body.template.type} (after ${head.body.template.type})`);
      } catch (err) {
        failures.push(`${d.slug}: ${err.message}`);
      }
    }
  }
  if (failures.length) {
    console.log(`\n${failures.length} refused:`);
    for (const f of failures) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
