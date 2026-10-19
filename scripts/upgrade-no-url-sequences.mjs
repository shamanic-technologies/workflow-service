#!/usr/bin/env node
/**
 * WF-NOBELIUM-BALLAD-UPGRADE-1019 — a new version of two cold-email dynasties of
 * `sales-cold-email-outreach`, with no link in ANY email of the sequence and short,
 * spaced paragraphs in EVERY email (owner 2026-10-19: « New versions of both
 * (upgrade, not fork), et l'absence d'URL doit être dans toute la séquence, pas
 * seulement dans le premier email. Même chose pour l'espacement. »).
 *
 *   Nobelium  blind-discovery-email-v33 -> blind-discovery-email-v33-no-url
 *   Ballad    cold-email-v59            -> cold-email-v59-no-url-spaced
 *
 * Both dynasties were ORPHANED on 2026-10-06 16:26:48 UTC: the stale sweep deprecated
 * their head (zero runs on the head itself, thousands on the lineage) and left no
 * successor. POST /workflows/upgrade builds on such a dynasty's latest version and
 * leaves that version as it is.
 *
 * The defect is fixed in the TEMPLATE TEXT the writer reads (owner rule), never by an
 * output check. The new templates are derived from their source by anchored edits:
 * an anchor missing from the source throws, so a source that drifted is never
 * half-edited. `POST /platform-prompts` no-ops on an existing type, so a stored copy is
 * COMPARED with what this script builds and a difference stops the run.
 *
 * The DAG changes ONE thing besides the template: Nobelium no longer maps
 * `body.variables.brands` (the brands JSON, whose only use in the old template was the
 * click destination URL; the new template declares no `brands`).
 *
 * Usage (inside the workflow-service container, its own env):
 *   node scripts/upgrade-no-url-sequences.mjs            # dry run
 *   node scripts/upgrade-no-url-sequences.mjs --templates-only   # store the two templates, upgrade nothing (dry render first)
 *   node scripts/upgrade-no-url-sequences.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY,
 *      UPGRADE_USER_ID (a real staff user id), WORKFLOW_SERVICE_LOCAL_URL (default http://localhost:8080)
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const FEATURE_SLUG = "sales-cold-email-outreach";

export const NO_LINKS_BLOCK = `## No links, in any email
None of the three emails contains a link. No URL, no web address, no domain name (nothing like "name.com", "www." or "http"), no "visit our site", "check out our page" or "link below". This holds for email 1 AND for each follow-up, with no exception.

The brand intel may list websites, pages or source URLs. They are background for you, never something to write in an email. The only ask is a reply to the email itself.`;

export const SPACING_BLOCK = `## Short, spaced paragraphs, in every email
Every email, email 1 AND each follow-up, is written in short paragraphs separated by a blank line. A paragraph holds at most two sentences and stays under 40 words. One idea per paragraph.

When a thought needs more, split it into two paragraphs. Never glue several sentences into one block: a wall of text loses the reader on mobile.`;

function edit(text, anchor, replacement) {
  if (!text.includes(anchor)) throw new Error(`anchor not found in source template: ${JSON.stringify(anchor.slice(0, 80))}`);
  if (text.indexOf(anchor) !== text.lastIndexOf(anchor)) throw new Error(`anchor not unique: ${JSON.stringify(anchor.slice(0, 80))}`);
  return text.replace(anchor, () => replacement);
}

/** Nobelium: blind discovery sequence, no link anywhere, spacing stated for every email. */
export function buildNobeliumTemplate(source) {
  let prompt = source.prompt;
  prompt = edit(
    prompt,
    "IMPORTANT: When you include or refer to a brand’s destination URL, use that brand’s clickDestinationUrl exactly as provided in the brands JSON, the full URL including its path. Never strip or shorten it to the root domain.\n",
    "",
  );
  prompt = edit(prompt, "Brands data: {{brands}}\n", "");
  // content-generation refuses a template that describes one company (TEMPLATE_NOT_NEUTRAL): the source's example
  // quoted one client's figures.
  prompt = edit(
    prompt,
    `If it mentions "20+ clients with documented results on dinner workshops," that's what you reference,`,
    `If it mentions a client count with documented results, that's what you reference,`,
  );
  prompt = edit(
    prompt,
    `Break it into short paragraphs separated by a blank line. One idea per paragraph. A wall of glued-together sentences loses the reader on mobile, no matter how good the copy is. Think of how you'd write a quick note on Slack: a line, a line, a line, an ask. Each on its own breath.`,
    `Think of how you'd write a quick note on Slack: a line, a line, a line, an ask. Each on its own breath.\n\n${SPACING_BLOCK}`,
  );
  prompt = edit(prompt, "\n---\n\nNow write the sequence for:", `\n${NO_LINKS_BLOCK}\n\n---\n\nNow write the sequence for:`);
  const variables = source.variables.filter((v) => v.name !== "brands");
  return { type: `${source.type}-no-url`, prompt, variables };
}

/** Ballad: researched-observation sequence, no link anywhere, short spaced paragraphs in every email. */
export function buildBalladTemplate(source) {
  let prompt = source.prompt;
  prompt = edit(
    prompt,
    "- Observation paragraph: 2-4 sentences that show real homework.",
    "- Observation: one or two short paragraphs (at most two sentences each) that show real homework.",
  );
  prompt = edit(
    prompt,
    "End the paragraph with a question that makes the tension concrete",
    "End the observation with a question that makes the tension concrete",
  );
  prompt = edit(
    prompt,
    "Emails 2 and 3 follow a similar aerated structure but shorter, usually one observation/angle paragraph and one short CTA. Same greeting style.",
    "Emails 2 and 3 follow the same aerated structure, shorter: one short angle paragraph and one short CTA, each on its own, separated by a blank line. Same greeting style.",
  );
  prompt = edit(prompt, "\n## Honesty floor\n", `\n${SPACING_BLOCK}\n\n${NO_LINKS_BLOCK}\n\n## Honesty floor\n`);
  return { type: `${source.type}-no-url-spaced`, prompt, variables: source.variables };
}

export const TARGETS = [
  {
    dynasty: "sales-cold-email-outreach-nobelium",
    sourceType: "blind-discovery-email-v33",
    build: buildNobeliumTemplate,
    dropVariables: ["brands"],
    description:
      "Anonymous B2B discovery email sequence optimized for positive replies. Never reveals the client name. No email of the sequence, the first one or a follow-up, carries a link, a URL or a domain name. Every email is written in short paragraphs separated by a blank line. Uses lead enrichment (LinkedIn headline, company description, keywords, tech stack) with brand intelligence to write personal, peer-to-peer emails that offer an intro to the team and close on a question to reply to.",
  },
  {
    dynasty: "sales-cold-email-outreach-ballad",
    sourceType: "cold-email-v59",
    build: buildBalladTemplate,
    dropVariables: [],
    description:
      "Researched B2B cold email sequence (3 emails) optimized for positive replies: an observation about the prospect's world, the client named with what it does, then a diagnostic question to reply to. No email of the sequence, the first one or a follow-up, carries a link, a URL or a domain name. Every email is written in short paragraphs (at most two sentences each) separated by a blank line. Uses enriched lead data with 19-field brand intelligence extraction.",
  },
];

/** A copy of the DAG whose content-generation node asks for `type` and maps none of `dropVariables`. */
export function retemplateDag(dag, fromType, toType, dropVariables) {
  const copy = structuredClone(dag);
  let hits = 0;
  for (const node of copy.nodes) {
    if (node?.config?.service !== "content-generation" || node.config?.path !== "/generate") continue;
    if (node.config.body?.type !== fromType) throw new Error(`content node ${node.id} asks for ${node.config.body?.type}, expected ${fromType}`);
    node.config.body.type = toType;
    for (const name of dropVariables) delete node.inputMapping?.[`body.variables.${name}`];
    hits += 1;
  }
  if (hits !== 1) throw new Error(`expected exactly one content-generation /generate node, found ${hits}`);
  return copy;
}

const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";

async function call(base, key, method, path, body, identity) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...(identity ?? {}) },
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
  const APPLY = process.argv.includes("--apply") || process.argv.includes("--templates-only");
  const TEMPLATES_ONLY = process.argv.includes("--templates-only");
  const { WORKFLOW_SERVICE_API_KEY: WS_KEY, CONTENT_GENERATION_SERVICE_URL: CG, CONTENT_GENERATION_SERVICE_API_KEY: CG_KEY, UPGRADE_USER_ID } = process.env;
  if (!WS_KEY || !CG || !CG_KEY || !UPGRADE_USER_ID) throw new Error("WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY and UPGRADE_USER_ID are required");
  const identity = (orgId) => ({ "x-org-id": orgId, "x-user-id": UPGRADE_USER_ID, "x-run-id": randomUUID() });

  for (const t of TARGETS) {
    const src = await call(CG, CG_KEY, "GET", `/platform-prompts?type=${encodeURIComponent(t.sourceType)}`);
    if (src.status !== 200) throw new Error(`source template ${t.sourceType}: ${src.status}`);
    const built = t.build(src.body);
    const stored = await call(CG, CG_KEY, "GET", `/platform-prompts?type=${encodeURIComponent(built.type)}`);
    if (stored.status === 200) {
      if (stored.body.prompt !== built.prompt) throw new Error(`template ${built.type} already stored and DIFFERS from what this script builds`);
      console.log(`${built.type}: already stored, matches`);
    } else if (APPLY) {
      const created = await call(CG, CG_KEY, "POST", "/platform-prompts", built);
      if (created.status !== 200 && created.status !== 201) throw new Error(`creating ${built.type}: ${created.status} ${JSON.stringify(created.body)}`);
      console.log(`${built.type}: created`);
    } else {
      console.log(`${built.type}: would create (${built.prompt.length} chars)`);
    }

    if (TEMPLATES_ONLY) continue;
    const listed = await call(WS, WS_KEY, "GET", `/workflows/summaries?featureSlug=${FEATURE_SLUG}&workflowDynastySlug=${t.dynasty}&status=all`, undefined, identity(randomUUID()));
    if (listed.status !== 200) throw new Error(`summaries ${t.dynasty}: ${listed.status}`);
    const versions = (listed.body.workflows ?? listed.body).filter((w) => w.workflowDynastySlug === t.dynasty);
    const latest = versions.reduce((a, b) => (a && a.version >= b.version ? a : b), undefined);
    if (!latest) throw new Error(`${t.dynasty}: no version`);
    const head = (await call(WS, WS_KEY, "GET", `/workflows/${latest.id}`, undefined, identity(randomUUID()))).body;
    const headType = head.dag.nodes.find((n) => n?.config?.service === "content-generation")?.config?.body?.type;
    if (headType === built.type) {
      console.log(`${t.dynasty}: v${head.version} already on ${built.type}, skipped`);
      continue;
    }
    const dag = retemplateDag(head.dag, t.sourceType, built.type, t.dropVariables);
    console.log(`${t.dynasty}: v${head.version} (${head.status}) ${t.sourceType} -> ${built.type}`);
    if (!APPLY) continue;
    const up = await call(WS, WS_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: t.dynasty, dag, description: t.description }, identity(head.orgId));
    if (up.status !== 201) throw new Error(`upgrade ${t.dynasty}: ${up.status} ${JSON.stringify(up.body).slice(0, 500)}`);
    console.log(`${t.dynasty}: created ${up.body.workflow.workflowSlug} (id ${up.body.workflow.id})`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
