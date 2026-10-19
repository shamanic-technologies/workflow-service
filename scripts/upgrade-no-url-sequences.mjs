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
 *   node scripts/upgrade-no-url-sequences.mjs --apply [--only <dynasty>,<dynasty>]
 * Env: FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY,
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

const NO_LINK_SENTENCE = "No email of the sequence, the first one or a follow-up, carries a link, a URL or a domain name.";
const SPACING_SENTENCE = "Every email is written in short paragraphs (at most two sentences each) separated by a blank line.";

const BLIND_V33_CLICK_URL_LINE =
  "IMPORTANT: When you include or refer to a brand’s destination URL, use that brand’s clickDestinationUrl exactly as provided in the brands JSON, the full URL including its path. Never strip or shorten it to the root domain.\n";
const SLACK_SPACING = [
  `Break it into short paragraphs separated by a blank line. One idea per paragraph. A wall of glued-together sentences loses the reader on mobile, no matter how good the copy is. Think of how you'd write a quick note on Slack: a line, a line, a line, an ask. Each on its own breath.`,
  `Think of how you'd write a quick note on Slack: a line, a line, a line, an ask. Each on its own breath.`,
];
const NEUTRAL_CLIENT_COUNT = [
  `If it mentions "20+ clients with documented results on dinner workshops," that's what you reference,`,
  `If it mentions a client count with documented results, that's what you reference,`,
];
const OBSERVATION_SPACING = [
  ["- Observation paragraph: 2-4 sentences that show real homework.", "- Observation: one or two short paragraphs (at most two sentences each) that show real homework."],
  ["End the paragraph with a question that makes the tension concrete", "End the observation with a question that makes the tension concrete"],
  [
    "Emails 2 and 3 follow a similar aerated structure but shorter, usually one observation/angle paragraph and one short CTA. Same greeting style.",
    "Emails 2 and 3 follow the same aerated structure, shorter: one short angle paragraph and one short CTA, each on its own, separated by a blank line. Same greeting style.",
  ],
];
const NOW_WRITE = "\n---\n\nNow write the sequence for:";
const CLIENT_WEBSITE_TAIL = "\n\nYou can name the agency now that the URL is shared. Use the name naturally where it fits.\n\n";

/**
 * How each source template becomes its no-link (and spaced) or spaced-only twin. `always` edits apply to both,
 * `linkEdits` and `dropVariables` only when links go. Every anchor is asserted by `edit`.
 */
export const TEMPLATE_SPECS = {
  "blind-discovery-email-v33": {
    family: "blind",
    always: [NEUTRAL_CLIENT_COUNT, [SLACK_SPACING[0], `${SLACK_SPACING[1]}\n\n${SPACING_BLOCK}`]],
    linkEdits: [[BLIND_V33_CLICK_URL_LINE, ""], ["Brands data: {{brands}}\n", ""]],
    dropVariables: ["brands"],
    insertBefore: NOW_WRITE,
    spacingInBody: true,
  },
  "blind-discovery-email-v26-landing-v3": {
    family: "blind-landing",
    always: [NEUTRAL_CLIENT_COUNT, [SLACK_SPACING[0], `${SLACK_SPACING[1]}\n\n${SPACING_BLOCK}`]],
    linkEdits: [[BLIND_V33_CLICK_URL_LINE, ""], ["Brands data: {{brands}}\n", ""]],
    dropVariables: ["brands"],
    insertBefore: NOW_WRITE,
    spacingInBody: true,
  },
  "cold-email-v40": { family: "observation", always: OBSERVATION_SPACING, linkEdits: [], dropVariables: [], insertBefore: "\n## Honesty floor\n" },
  "cold-email-v39-landing-v3": { family: "observation-landing", always: OBSERVATION_SPACING, linkEdits: [], dropVariables: [], insertBefore: "\n## Honesty floor\n" },
  "blind-discovery-email-v22": {
    family: "intro",
    always: [],
    linkEdits: [
      [
        `## The client's website\nDrop the client's URL ({{clientWebsite}}) once at the end of email 1, casually, after the ask. Not in emails 2 or 3. The link is a footnote for context, not a CTA — keep the framing offhand and never marketing. \nCRITICAL: Output the URL EXACTLY as provided in {{clientWebsite}}, including any paths or query parameters (e.g., if provided "https://labcritics.com/advertise/", do not strip it down to the root domain "https://labcritics.com").${CLIENT_WEBSITE_TAIL}`,
        "",
      ],
      ["- Website: {{clientWebsite}}\n", ""],
    ],
    dropVariables: ["clientWebsite"],
    insertBefore: NOW_WRITE,
  },
  "blind-discovery-email-v21": {
    family: "intro",
    always: [],
    linkEdits: [
      ["- Client URL as a casual footnote.\n", ""],
      // Without the URL the agency is never named: the email says who it represents without a name.
      ["- One line: who you represent and what they do.", "- One line: that you represent a team (never named) and what they do."],
      [
        `## The client's website\nDrop the client's URL ({{clientWebsite}}) once at the end of email 1, casually, after the ask. Not in emails 2 or 3. The link is a footnote for context, not a CTA — keep the framing offhand and never marketing.\nIMPORTANT: Do NOT strip or shorten the URL. You MUST use the exact, full destination URL provided in {{clientWebsite}} (e.g., if it includes a path like /advertise/, keep it exactly as is).${CLIENT_WEBSITE_TAIL}`,
        "",
      ],
      ["- Website: {{clientWebsite}}\n", ""],
    ],
    dropVariables: ["clientWebsite"],
    insertBefore: NOW_WRITE,
  },
  "cold-email-v37": {
    family: "contrarian",
    // content-generation refuses a template quoting one vendor's study figures (TEMPLATE_NOT_NEUTRAL): same advice, no figure.
    always: [
      ['Example: "Companies like [Similar Company] increased response rates by 40%.', 'Example: "Companies like [Similar Company] got more replies once they changed how they reach out.'],
      ["## Industry data (Gong research, 28M+ emails analyzed)\nThese findings should inform your choices:", "## What tends to work in cold email\nThese patterns should inform your choices:"],
      ["- Product pitches in cold emails reduce replies by 57%.", "- Product pitches in cold emails cut replies."],
      ["generate 2x more replies than", "get more replies than"],
      ["Buzzwords in subject lines reduce open rates by 17.9%.", "Buzzwords in subject lines lower open rates."],
      ["- Top-performing reps book 8.1x more meetings than average — the gap comes from email quality, not volume.", "- The reps who book the most meetings win on email quality, not volume."],
      [" as provided in the input (e.g., https://labcritics.com/advertise/).", " as provided in the input, path included."],
    ],
    linkEdits: [
      [
        "## URLs\nIf you display a client URL in the email, you MUST use the exact, full destination URL as provided in the input, path included. Do NOT strip it down to the root domain.\n\n",
        "",
      ],
    ],
    dropVariables: [],
    insertBefore: NOW_WRITE,
  },
};

/**
 * The twin of a source template: no link in any email AND short spaced paragraphs (`keepLinks: false`, type
 * `<source>-no-url-spaced`), or short spaced paragraphs only (`keepLinks: true`, type `<source>-spaced`), for a
 * dynasty whose pipe ends on a website visit, where the link is the point.
 */
export function deriveTemplate(source, { keepLinks }) {
  const spec = TEMPLATE_SPECS[source.type];
  if (!spec) throw new Error(`no template spec for ${source.type}`);
  let prompt = source.prompt;
  for (const [anchor, replacement] of spec.always) prompt = edit(prompt, anchor, replacement);
  if (!keepLinks) for (const [anchor, replacement] of spec.linkEdits) prompt = edit(prompt, anchor, replacement);
  const blocks = [spec.spacingInBody ? null : SPACING_BLOCK, keepLinks ? null : NO_LINKS_BLOCK].filter(Boolean).join("\n\n");
  if (blocks) prompt = edit(prompt, spec.insertBefore, `\n${blocks}\n${spec.insertBefore}`);
  const dropped = keepLinks ? [] : spec.dropVariables;
  return {
    type: `${source.type}${keepLinks ? "-spaced" : "-no-url-spaced"}`,
    prompt,
    variables: source.variables.filter((v) => !dropped.includes(v.name)),
  };
}

const FAMILY_DESCRIPTIONS = {
  blind: "Anonymous B2B discovery email sequence optimized for positive replies. Never reveals the client name. Personal, peer-to-peer emails built on lead enrichment and brand intelligence that offer an intro to the team and close on a question to reply to.",
  "blind-landing": "Anonymous B2B discovery email sequence optimized for positive replies. Never reveals the client name. Reads the prospect's own landing page to personalize, offers an intro to the team and closes on a question to reply to.",
  observation: "Researched B2B cold email sequence (3 emails) optimized for positive replies: an observation about the prospect's world, the client named with what it does, then a diagnostic question to reply to. Uses enriched lead data with brand intelligence extraction.",
  "observation-landing": "Researched B2B cold email sequence (3 emails) optimized for positive replies: an observation about the prospect's world (their own landing page read), the client named with what it does, then a diagnostic question to reply to.",
  intro: "B2B pitch sequence framed as an intro to a peer-credible team, built on lead enrichment and brand intelligence. Closes with a low-stakes intro ask rather than a demo CTA.",
  contrarian: "Short B2B cold email sequence (3 emails) that opens on a contrarian angle about the prospect's world and ends on a soft, low-friction ask.",
};

export function describeVariant(family, keepLinks) {
  const linkLine = keepLinks
    ? family === "intro" ? "Email 1 drops the client's URL once, as a footnote." : null
    : NO_LINK_SENTENCE;
  return [FAMILY_DESCRIPTIONS[family], linkLine, SPACING_SENTENCE].filter(Boolean).join(" ");
}

/**
 * The legacy pair (first ship, templates already stored): their builders stay byte-identical. Every other
 * dynasty decides links from the legs features-service assigns it: Positive reply only = no link, Website visit
 * only = spacing only, both = refused (features-service resolves every dynasty to one leg, ONE-LEG-PER-WORKFLOW-1019).
 * Nobelium is no-link on both of its legs: the owner's decision of 2026-10-19 named it.
 */
export const TARGETS = [
  {
    dynasty: "sales-cold-email-outreach-nobelium",
    sourceType: "blind-discovery-email-v33",
    build: buildNobeliumTemplate,
    forceNoLinks: true,
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
  // Extension (owner go 2026-10-19, relayed by istanbul-v9): every mature Positive reply workflow left with no
  // runnable version.
  ...[
    ["tectonic", "cold-email-v37"],
    ["cirque", "blind-discovery-email-v21"],
    ["bronze-2", "blind-discovery-email-v22"],
    ["arcadia", "cold-email-v40"],
    ["helm", "blind-discovery-email-v26-landing-v3"],
    ["baobab", "cold-email-v39-landing-v3"],
    ["lithium", "blind-discovery-email-v33"],
    ["cerulean", "blind-discovery-email-v33"],
  ].map(([name, sourceType]) => ({ dynasty: `${FEATURE_SLUG}-${name}`, sourceType })),
];

/** A blind template never names nor links the client (content-generation's rule, keyed on the type name). */
export const isBlind = (type) => type.startsWith("blind-");

export const POSITIVE_REPLY_LEG = "lead_found_to_conversation";
export const WEBSITE_VISIT_LEG = "lead_found_to_website_visit";

/** Template, DAG drops and description for one target, given the legs it is actively assigned to. */
export function planTarget(target, source, legs) {
  if (target.build) {
    if (!target.forceNoLinks && !(legs.length === 1 && legs[0] === POSITIVE_REPLY_LEG)) {
      throw new Error(`${target.dynasty}: expected the Positive reply leg only, found ${legs.join(", ") || "none"}`);
    }
    return { keepLinks: false, built: target.build(source), dropVariables: target.dropVariables, description: target.description };
  }
  let keepLinks;
  if (legs.length === 1 && legs[0] === POSITIVE_REPLY_LEG) keepLinks = false;
  else if (legs.length === 1 && legs[0] === WEBSITE_VISIT_LEG) keepLinks = true;
  else throw new Error(`${target.dynasty}: active on ${legs.join(", ") || "no leg"}, not on exactly one of the two legs: not upgraded`);
  if (keepLinks && isBlind(source.type)) {
    // content-generation refuses a blind template that lets the writer link the client (BLIND_TEMPLATE_REVEALS_CLIENT).
    throw new Error(`${target.dynasty}: ends on the Website visit leg but runs a blind template, which can never carry the client's link: not upgraded`);
  }
  // A no-link twin of v33 is the one Nobelium already runs (same text, stored once).
  const built = !keepLinks && source.type === "blind-discovery-email-v33" ? buildNobeliumTemplate(source) : deriveTemplate(source, { keepLinks });
  const spec = TEMPLATE_SPECS[source.type];
  return {
    keepLinks,
    built,
    dropVariables: keepLinks ? [] : spec.dropVariables,
    description: describeVariant(spec.family, keepLinks),
  };
}

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

  const ONLY = (() => {
    const i = process.argv.indexOf("--only");
    return i === -1 ? null : process.argv[i + 1].split(",");
  })();
  const fsRes = await call(process.env.FEATURES_SERVICE_URL, process.env.FEATURES_SERVICE_API_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${FEATURE_SLUG}`);
  if (fsRes.status !== 200) throw new Error(`features-service assignments: ${fsRes.status}`);
  const legsOf = (dynasty) => fsRes.body.assignments.filter((a) => a.workflowDynastySlug === dynasty && a.state === "active").map((a) => a.legKey).sort();

  const failures = [];
  for (const t of TARGETS) {
    if (ONLY && !ONLY.includes(t.dynasty)) continue;
    try {
      await upgradeOne(t);
    } catch (err) {
      failures.push(t.dynasty);
      console.log(`${t.dynasty}: NOT UPGRADED: ${err.message}`);
    }
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} not upgraded: ${failures.join(", ")}`);
    process.exitCode = 1;
  }

  async function ensureTemplate(built) {
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
  }

  async function upgradeOne(t) {
    const src = await call(CG, CG_KEY, "GET", `/platform-prompts?type=${encodeURIComponent(t.sourceType)}`);
    if (src.status !== 200) throw new Error(`source template ${t.sourceType}: ${src.status}`);
    if (TEMPLATES_ONLY) {
      // Both twins of a non-legacy source, so either can be dry-rendered before its dynasty's leg is settled.
      const twins = t.build
        ? [t.build(src.body)]
        : [false, true].filter((keepLinks) => !(keepLinks && isBlind(t.sourceType))).map((keepLinks) => deriveTemplate(src.body, { keepLinks }));
      for (const twin of twins) await ensureTemplate(twin);
      return;
    }
    const legs = legsOf(t.dynasty);
    const plan = planTarget(t, src.body, legs);
    const built = plan.built;
    await ensureTemplate(built);
    const listed = await call(WS, WS_KEY, "GET", `/workflows/summaries?featureSlug=${FEATURE_SLUG}&workflowDynastySlug=${t.dynasty}&status=all`, undefined, identity(randomUUID()));
    if (listed.status !== 200) throw new Error(`summaries ${t.dynasty}: ${listed.status}`);
    const versions = (listed.body.workflows ?? listed.body).filter((w) => w.workflowDynastySlug === t.dynasty);
    const latest = versions.reduce((a, b) => (a && a.version >= b.version ? a : b), undefined);
    if (!latest) throw new Error(`${t.dynasty}: no version`);
    const head = (await call(WS, WS_KEY, "GET", `/workflows/${latest.id}`, undefined, identity(randomUUID()))).body;
    const headType = head.dag.nodes.find((n) => n?.config?.service === "content-generation")?.config?.body?.type;
    if (headType === built.type) {
      console.log(`${t.dynasty}: v${head.version} already on ${built.type}, skipped`);
      return;
    }
    const dag = retemplateDag(head.dag, t.sourceType, built.type, plan.dropVariables);
    console.log(`${t.dynasty}: v${head.version} (${head.status}) on ${legs.join(", ")}: ${t.sourceType} -> ${built.type}`);
    if (!APPLY) return;
    const up = await call(WS, WS_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: t.dynasty, dag, description: plan.description }, identity(head.orgId));
    if (up.status !== 201) throw new Error(`upgrade ${t.dynasty}: ${up.status} ${JSON.stringify(up.body).slice(0, 500)}`);
    console.log(`${t.dynasty}: created ${up.body.workflow.workflowSlug} (id ${up.body.workflow.id})`);
    // createRateLimit: 10 creations per minute per org.
    await new Promise((r) => setTimeout(r, 7000));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
