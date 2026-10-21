#!/usr/bin/env node
/**
 * TPL-DYNASTY-1021-WF (4a) — short, spaced paragraphs in every email of the Blind Free Offer template
 * (`cold-reply-free-offer-blind`, head blind-discovery-email-v47, byte-identical to v40). Mebsuta (v40) and
 * Azalea (v47) sent wall-of-text emails (10 of 81 since 10-17 had no blank line at all): the 10-19 spacing fix
 * (`SPACING_BLOCK`, scripts/upgrade-no-url-sequences.mjs) only reached orphaned dynasties.
 *
 * The fix is in the TEMPLATE TEXT (owner rule): `SPACING_BLOCK` + the greeting alone on its own line, inserted by
 * an anchored edit (a missing anchor throws). `POST /platform-prompts` no-ops on an existing type, so a stored
 * copy is COMPARED with what this script builds. Each workflow is UPGRADED onto it (never forked); a head already
 * on it is skipped, so a re-run is a no-op.
 *
 * Usage (inside the workflow-service container, its own env):
 *   node scripts/space-template-heads.mjs            # dry run
 *   node scripts/space-template-heads.mjs --apply
 * Env: WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY,
 *      UPGRADE_USER_ID (a real staff user id), WORKFLOW_SERVICE_LOCAL_URL (default http://localhost:8080)
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { SPACING_BLOCK, edit, call, retemplateDag } from "./upgrade-no-url-sequences.mjs";

export const FEATURE_SLUG = "sales-cold-email-outreach";

export const GREETING_LINE = "The greeting (the email's language, then the first name) stays alone on its own line, followed by a blank line.";

/**
 * content-generation refuses a stored template that names or quotes one company, figure or person
 * (TEMPLATE_NOT_NEUTRAL), and the source's illustrative examples did (Stripe, "Sarah Chen", "72%", "Apollo"):
 * same advice, bracketed placeholders instead of the specifics.
 */
export const BLIND_FREE_OFFER_NEUTRAL_EDITS = [
  [
    `Example: "72% of enterprise teams are rolling back AI tools within 6 months,
and your team just posted 3 AI engineering roles. We helped [Similar Company] cut
AI deployment failure rate by 80% in one quarter. Worth 15 min Tuesday to see if
relevant?"`,
    `Example: "[A true, sharp fact about their industry], and your team just
[a visible trigger: a hiring spike, a funding round, a launch]. We helped [Similar Company]
[a real result from the brand intel]. Worth a quick look to see if relevant?"`,
  ],
  [
    `Example: "Compliance teams face 3x more regulation since 2022, most
still using spreadsheets. Saw [Company] just expanded into EU markets. We built
the first AI Act audit tool for non-technical legal teams. Your Head of Compliance might want to see how [Similar Company] cut audit prep from 6 weeks to 3 days."`,
    `Example: "[Their kind of team] faces [a real, growing pressure], most
still handle it [the old way]. Saw [Company] just [a trigger]. We built
[what the client does, in plain words]. Your [relevant role] might want to see how [Similar Company] [a real result]."`,
  ],
  [
    `Example: "Just finished our Q1 2026 benchmark across 2,400 SaaS companies on churn reduction, your segment  (Series B, PLG) shows a pattern I haven't seen published anywhere. Happy to share the data + walk through how it maps to [Company]'s growth stage."`,
    `Example: "Just finished a benchmark across [businesses like theirs] on [the topic the client knows best], your segment shows a pattern I haven't seen published anywhere. Happy to share the data + walk through how it maps to [Company]'s growth stage."`,
  ],
  [
    `**Social proof from named customers outperforms self-description.** "Helped
Stripe reduce churn 40%" lands harder than "a leading customer success platform."`,
    `**Social proof from named customers outperforms self-description.** "Helped
[a named customer] [a measured result]" lands harder than "a leading platform."`,
  ],
  [
    `"Sarah Chen, our Head of AI (ex-Stripe, built their fraud detection system) can walk you through how this maps to your stack" is a reason to reply.`,
    `"[A named teammate], our [role] ([a credential that matters to them]) can walk you through how this maps to your stack" is a reason to reply.`,
  ],
  ["They come from Apollo and might be outdated.", "They come from a data provider and might be outdated."],
];

export const SPACED_TARGETS = [
  {
    sourceType: "blind-discovery-email-v47",
    anchor: "\n## Opening line (Email 1 only)\n",
    neutralEdits: BLIND_FREE_OFFER_NEUTRAL_EDITS,
    dynasties: [`${FEATURE_SLUG}-mebsuta`, `${FEATURE_SLUG}-azalea`],
  },
];

/**
 * The spaced twin of a source template: its neutral edits, then `SPACING_BLOCK` + the greeting line right before
 * `anchor`. Every anchor is asserted by `edit`.
 */
export function buildSpacedTemplate(source, anchor, neutralEdits = []) {
  if (source.prompt.includes(SPACING_BLOCK)) throw new Error(`${source.type} already carries the spacing block`);
  let prompt = source.prompt;
  for (const [from, to] of neutralEdits) prompt = edit(prompt, from, to);
  prompt = edit(prompt, anchor, `\n${SPACING_BLOCK}\n\n${GREETING_LINE}\n${anchor}`);
  return { type: `${source.type}-spaced`, prompt, variables: source.variables };
}

const contentType = (dag) => dag.nodes.find((n) => n?.config?.service === "content-generation" && n?.config?.path === "/generate")?.config?.body?.type;

async function run() {
  const APPLY = process.argv.includes("--apply");
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const { WORKFLOW_SERVICE_API_KEY: WS_KEY, CONTENT_GENERATION_SERVICE_URL: CG, CONTENT_GENERATION_SERVICE_API_KEY: CG_KEY, UPGRADE_USER_ID } = process.env;
  if (!WS_KEY || !CG || !CG_KEY || !UPGRADE_USER_ID) throw new Error("WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY and UPGRADE_USER_ID are required");
  const identity = (orgId) => ({ "x-org-id": orgId, "x-user-id": UPGRADE_USER_ID, "x-run-id": randomUUID() });
  const failures = [];

  for (const t of SPACED_TARGETS) {
    const src = await call(CG, CG_KEY, "GET", `/platform-prompts?type=${encodeURIComponent(t.sourceType)}`);
    if (src.status !== 200) throw new Error(`source template ${t.sourceType}: ${src.status}`);
    const built = buildSpacedTemplate(src.body, t.anchor, t.neutralEdits);
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

    for (const dynasty of t.dynasties) {
      try {
        const listed = await call(WS, WS_KEY, "GET", `/workflows/summaries?featureSlug=${FEATURE_SLUG}&workflowDynastySlug=${dynasty}&status=active`, undefined, identity(randomUUID()));
        if (listed.status !== 200) throw new Error(`summaries: ${listed.status}`);
        const active = (listed.body.workflows ?? listed.body).find((w) => w.workflowDynastySlug === dynasty);
        if (!active) throw new Error("no active version");
        const head = (await call(WS, WS_KEY, "GET", `/workflows/${active.id}`, undefined, identity(randomUUID()))).body;
        const fromType = contentType(head.dag);
        if (fromType === built.type) {
          console.log(`${dynasty}: v${head.version} already on ${built.type}, skipped`);
          continue;
        }
        // The source text, under its own type or a byte-identical twin (v40 = v47).
        const fromText = await call(CG, CG_KEY, "GET", `/platform-prompts?type=${encodeURIComponent(fromType)}`);
        if (fromText.body?.prompt !== src.body.prompt) throw new Error(`runs ${fromType}, whose text is not ${t.sourceType}'s`);
        const dag = retemplateDag(head.dag, fromType, built.type, []);
        console.log(`${dynasty}: v${head.version}: ${fromType} -> ${built.type}`);
        if (!APPLY) continue;
        const up = await call(WS, WS_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: dynasty, dag }, identity(head.orgId));
        if (up.status !== 201) throw new Error(`upgrade: ${up.status} ${JSON.stringify(up.body).slice(0, 500)}`);
        console.log(`${dynasty}: created ${up.body.workflow.workflowSlug} (id ${up.body.workflow.id})`);
        await new Promise((r) => setTimeout(r, 7000)); // createRateLimit: 10 per minute per org
      } catch (err) {
        failures.push(dynasty);
        console.log(`${dynasty}: NOT UPGRADED: ${err.message}`);
      }
    }
  }
  if (failures.length > 0) {
    console.log(`\n${failures.length} not upgraded: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
