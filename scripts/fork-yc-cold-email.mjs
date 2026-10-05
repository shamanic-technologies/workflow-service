#!/usr/bin/env node
/**
 * Ops script: ship the "YC cold email" sequence as a NEW dynasty on
 * `sales-cold-email-outreach`, running on `glm-pro`, and put it on the Herald
 * leg (`start_to_conversation`, outcome = positive reply) beside the
 * workflows already there (owner, 2026-10-05).
 *
 * The template is written ONLY from Y Combinator's cold-email advice: three
 * sentences (what the client does, the best proof, an explicit one-line ask),
 * never a meeting ask, no backstory or flattery, a casual subject, two short
 * follow-ups. Its variables and output format are those of `cold-email-v33`,
 * the best template on Herald by cost per positive reply on the Research page
 * snapshot of 2026-10-03; GLM Pro is that page's best model on the same leg.
 *
 * Three halves, in this order, same discipline as
 * `fork-acquisition-questions-sequence.mjs`:
 *
 *  1. The TEMPLATE. Its text lives HERE (`TEMPLATE_PROMPT`), owner-approved,
 *     and is stored in content-generation through `POST /platform-prompts`.
 *     That route no-ops on an existing type, so an existing template is
 *     COMPARED with what this file states and a drift is reported, never
 *     silently trusted. Variable DESCRIPTIONS are read off `cold-email-v33`,
 *     which states every token this body uses.
 *  2. The WORKFLOW. The source DAG is the active head of a NON-blind dynasty
 *     whose content call already maps all fourteen v33 tokens (default
 *     `sales-cold-email-outreach-osprey`: it ran cold-email-v33 itself in its
 *     v4-v6, and its head still maps clientName and clientWebsite, which no
 *     glm-pro head does). Resolved by dynasty slug at run time, heads move.
 *     Only the content call changes (`body.type`, `body.model`). A changed
 *     signature on `PUT /workflows/:id` is the FORK path: the source stays
 *     active and the fork starts a new dynasty at version 1.
 *  3. The LEG. features-service owns which dynasties a leg may pick
 *     (`PUT /internal/workflow-leg-assignments`). The new dynasty is ADDED as
 *     `active` on `start_to_conversation`; no other assignment is written, and
 *     the script re-reads the leg afterwards and fails if any other row moved.
 *
 * Idempotent: a re-run finds the template stored, the fork answering 409 with
 * the existing workflow, and the assignment already active, and says so.
 *
 * Usage (inside the workflow-service container, against dist):
 *
 *   node fork-yc-cold-email.mjs --org <uuid>
 *   node fork-yc-cold-email.mjs --org <uuid> --apply
 *   [--dynasty <source dynasty slug>]
 *
 * The org must own the source workflow: a fork takes its org from the
 * caller's `x-org-id`.
 *
 * Env: WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL,
 *      CONTENT_GENERATION_SERVICE_API_KEY, FEATURES_SERVICE_URL,
 *      FEATURES_SERVICE_API_KEY (all required), BASE_URL (default
 *      http://localhost:8080).
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const FEATURE_SLUG = "sales-cold-email-outreach";
export const LEG_KEY = "start_to_conversation";
export const TEMPLATE_TYPE = "yc-cold-email-v1";
export const DESCRIPTION_SOURCE_TYPE = "cold-email-v33";
export const MODEL = "glm-pro";
export const DEFAULT_SOURCE_DYNASTY = "sales-cold-email-outreach-osprey";
export const DECIDED_BY = "kevin";
export const LEG_NOTE =
  "Owner decision 2026-10-05: YC cold-email template (yc-cold-email-v1) on GLM Pro, A/B beside the leg's other workflows.";

export const WORKFLOW_DESCRIPTION =
  "Cold-email sequence written only from Y Combinator's cold-email advice: three sentences (what the client does, " +
  "best proof, explicit one-line ask), never asks for a meeting, no backstory or flattery, casual subject, two short " +
  "follow-ups. Variables from cold-email-v33, runs on GLM Pro.";

/** Owner-approved text (2026-10-05), stored verbatim. */
export const TEMPLATE_PROMPT = `You're writing a 3-email cold sequence on behalf of a client. You name the client and say what they do. Every email has one goal: a reply from the prospect.

## Email 1: three sentences
Each sentence sits on its own line, separated by a blank line. The prospect reads it in under 60 seconds.
1. What the client does, by name, in plain words. Zero jargon, no adjectives piled on.
2. Why it matters to this prospect, led by the best proof in the brand intel: a named customer, a result with a number, a launch, growth, a known backer. A real name beats any adjective.
3. The ask, explicit, alone on the last line.

Open with "Hi {{leadFirstName}}," on its own line. No sign-off line: the signature is added after.

## The ask
Never ask for a meeting, a call or a demo. Let them escalate. Ask for something small they can answer in one line: whether this is a problem for them, who handles it at their company, or whether they want the link.

## Make it about them
Their problem, in the words someone in their job would use. Find one real reason it is them and not a thousand others: something specific in their company description, keywords, industry or headline. If nothing real stands out, do not fake one. A sentence that could go to 1,000 prospects unchanged is cut.

## What to leave out
- Backstory: no history of the client, no awards, no "founded in", no origin story.
- Flattery: no compliments on the prospect, their company, their role or their posts.
- Any word that does not serve the reply.

## Voice
Write like you talk to a friend. Read it out loud in your head: if it sounds like marketing or like an AI, rewrite it. No em dashes, no en dashes.

## Subject (email 1 only)
Two to five words, casual and relevant, like a friend wrote it. Not marketing.

## Follow-ups
Emails 2 and 3 go in the same thread (no new subject), about 3 days and about 7 days later. Each is one or two sentences: one new reason to reply (a fresh proof or angle from the brand intel), then the same small ask on its own line. Never restate email 1. Never "just bumping" or "did you see my email".

## Honesty floor
Use only what's in the brand intel. Don't invent results, customer names, backers or urgency. If a sentence would require making something up, cut it.

## Data hygiene
Apollo data comes in weird shapes: ALL CAPS company names, outdated employee counts, generic tech stack. Normalize names to title case. Skip weak signals that would sound robotic.

---

Now write the sequence for:

## Prospect
- Name: {{leadFirstName}} {{leadLastName}}
- Title: {{leadTitle}}
- LinkedIn Headline: {{leadHeadline}}
- Company: {{leadCompanyName}}
- Industry: {{leadCompanyIndustry}}
- Company Size: {{leadCompanySize}}
- Funding Stage: {{leadCompanyFundingStage}}
- Company Description: {{leadCompanyDescription}}
- Keywords: {{leadCompanyKeywords}}
- Tech Stack: {{leadCompanyTechStack}}

## Client
- Name: {{clientName}}
- Website: {{clientWebsite}}

## Brand Intelligence
{{brandExtractedFields}}

Output: the three emails, ready to send. Nothing else.`;

/** The `{{tokens}}` a body states, in order of first appearance. */
export function templateTokens(prompt) {
  return [...new Set([...prompt.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
}

/**
 * The template content-generation stores. `variables` is a contract — the
 * declared set must equal the body's tokens — and each description is read
 * off the template these tokens were taken from, so a missing one throws
 * rather than being invented.
 */
export function buildTemplateFor(spec, descriptionSource) {
  const described = new Map((descriptionSource.variables ?? []).map((v) => [v.name, v]));
  const variables = templateTokens(spec.templatePrompt).map((name) => {
    const v = described.get(name);
    if (!v || typeof v.description !== "string" || v.description.trim() === "") {
      throw new Error(
        `template "${descriptionSource.type}" carries no description for "{{${name}}}" — ` +
        `refusing to store "${spec.templateType}" with an undescribed variable`,
      );
    }
    return { name, description: v.description };
  });
  return { type: spec.templateType, prompt: spec.templatePrompt, variables };
}

/** The content-generation call: the only node in these DAGs posting to `/generate`. */
export function findGenerateNode(dag) {
  return dag.nodes.find((n) => n.config?.path === "/generate" && n.config?.body?.type);
}

/**
 * The source DAG with its content call pointed at the spec's template and model.
 * Every token the template states must already be mapped by the source, or the
 * fork would generate with a blank where a prospect or client fact belongs.
 */
export function withTemplateFor(spec, dag) {
  const clone = structuredClone(dag);
  const node = findGenerateNode(clone);
  if (!node) throw new Error("no content-generation /generate node in DAG");
  const mapped = new Set(
    Object.keys(node.inputMapping ?? {})
      .map((k) => k.match(/^body\.variables\.(.+)$/)?.[1])
      .filter(Boolean),
  );
  const unmapped = templateTokens(spec.templatePrompt).filter((t) => !mapped.has(t));
  if (unmapped.length > 0) {
    throw new Error(`source DAG does not map ${JSON.stringify(unmapped)} on its content call`);
  }
  node.config.body.type = spec.templateType;
  node.config.body.model = spec.model;
  return clone;
}

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
export const withYcColdEmail = (dag) => withTemplateFor(SPEC, dag);

/**
 * Every assignment on the leg other than `dynastySlug`, compared before and
 * after the write. Returns the rows that moved (added, removed or changed);
 * the write is meant to touch exactly one row, so anything here is a failure.
 */
export function otherAssignmentsMoved(before, after, dynastySlug) {
  const key = (a) => `${a.featureSlug}|${a.legKey}|${a.workflowDynastySlug}`;
  const strip = (rows) =>
    new Map(rows.filter((a) => a.workflowDynastySlug !== dynastySlug).map((a) => [key(a), JSON.stringify(a)]));
  const b = strip(before);
  const a = strip(after);
  const moved = [];
  for (const [k, v] of b) if (a.get(k) !== v) moved.push(k);
  for (const k of a.keys()) if (!b.has(k)) moved.push(k);
  return moved;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Template -> fork -> leg, for any `spec` shaped like `SPEC`. Shared with
 * `fork-yc-cold-email-click.mjs`; every check below holds for both.
 */
export async function runFork(spec) {
  const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
  const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
  const CG_URL = process.env.CONTENT_GENERATION_SERVICE_URL;
  const CG_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
  const FS_URL = process.env.FEATURES_SERVICE_URL;
  const FS_KEY = process.env.FEATURES_SERVICE_API_KEY;
  const APPLY = process.argv.includes("--apply");
  const ORG_ID = arg("org");
  const DYNASTY = arg("dynasty") ?? spec.defaultSourceDynasty;

  if (!API_KEY || !CG_URL || !CG_KEY || !FS_URL || !FS_KEY) {
    console.error(
      "WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY, " +
      "FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY are required",
    );
    process.exit(1);
  }
  if (!ORG_ID) {
    console.error("usage: --org <uuid> [--dynasty <slug>] [--apply]");
    process.exit(1);
  }

  async function request(url, method, headers, body) {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      payload = null;
    }
    return { status: res.status, payload };
  }
  const wf = (method, path, body) =>
    request(`${BASE_URL}${path}`, method, {
      "x-api-key": API_KEY,
      "x-org-id": ORG_ID,
      "x-user-id": randomUUID(),
      "x-run-id": randomUUID(),
    }, body);
  const cg = (method, path, body) => request(`${CG_URL}${path}`, method, { "x-api-key": CG_KEY }, body);
  const fs = (method, path, body) => request(`${FS_URL}${path}`, method, { "x-api-key": FS_KEY }, body);

  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");

  // 1. The template, BEFORE the workflow: a DAG naming a type content-generation
  //    has never stored is a workflow that 404s on its first run.
  const source = await cg("GET", `/platform-prompts?type=${encodeURIComponent(spec.descriptionSourceType)}`);
  if (source.status !== 200) {
    throw new Error(`description source ${spec.descriptionSourceType} unreadable (${source.status})`);
  }
  const template = buildTemplateFor(spec, source.payload);
  const existing = await cg("GET", `/platform-prompts?type=${encodeURIComponent(spec.templateType)}`);
  if (existing.status === 200) {
    if (existing.payload.prompt !== spec.templatePrompt) {
      throw new Error(`template ${spec.templateType} is stored but DIFFERS from this file; refusing to fork onto it`);
    }
    console.log(`template ${spec.templateType}: already stored, matches this file`);
  } else if (!APPLY) {
    console.log(`template ${spec.templateType}: would create (${template.prompt.length} chars, variables ${template.variables.map((v) => v.name).join(",")})`);
  } else {
    const created = await cg("POST", "/platform-prompts", template);
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`creating ${spec.templateType} failed ${created.status} ${JSON.stringify(created.payload)}`);
    }
    console.log(`template ${spec.templateType}: created`);
  }

  // 2. The workflow: fork the source dynasty's CURRENT head.
  const listed = await wf("GET", `/public/workflows?featureSlugs=${FEATURE_SLUG}&status=active`);
  if (listed.status !== 200) {
    throw new Error(`public list failed ${listed.status} ${JSON.stringify(listed.payload)}`);
  }
  const heads = (listed.payload.workflows ?? []).filter((w) => w.workflowDynastySlug === DYNASTY);
  if (heads.length !== 1) {
    throw new Error(`dynasty "${DYNASTY}" has ${heads.length} active versions, expected exactly 1`);
  }
  const got = await wf("GET", `/workflows/${heads[0].id}`);
  if (got.status !== 200) {
    throw new Error(`GET workflow ${heads[0].id} failed ${got.status} ${JSON.stringify(got.payload)}`);
  }
  const dag = withTemplateFor(spec, got.payload.dag);
  const sourceBody = findGenerateNode(got.payload.dag).config.body;
  console.log(`source: ${got.payload.workflowSlug} (${got.payload.id}), template ${sourceBody.type}, model ${sourceBody.model}`);

  if (!APPLY) {
    console.log(`would fork onto ${spec.templateType} / ${spec.model}, then assign the fork active on ${spec.legKey}`);
    return;
  }
  const put = await wf("PUT", `/workflows/${got.payload.id}`, { dag, description: spec.workflowDescription });
  let forkId;
  if (put.status === 201) {
    forkId = put.payload.id;
    console.log(`created ${put.payload.workflowSlug} (dynasty ${put.payload.workflowDynastySlug}, id ${forkId})`);
  } else if (put.status === 409 && put.payload?.existingWorkflowId) {
    forkId = put.payload.existingWorkflowId;
    console.log(`already covered by ${put.payload.existingWorkflowSlug}`);
  } else {
    throw new Error(`fork failed ${put.status} ${JSON.stringify(put.payload)}`);
  }
  const fork = await wf("GET", `/workflows/${forkId}`);
  if (fork.status !== 200) {
    throw new Error(`GET fork ${forkId} failed ${fork.status} ${JSON.stringify(fork.payload)}`);
  }
  const forkDynasty = fork.payload.workflowDynastySlug;
  if (findGenerateNode(fork.payload.dag)?.config.body.type !== spec.templateType) {
    throw new Error(`workflow ${fork.payload.workflowSlug} does not run ${spec.templateType}; refusing to assign it`);
  }

  // 3. The leg: add the fork, touch nothing else.
  const legQuery = `/internal/workflow-leg-assignments?featureSlug=${FEATURE_SLUG}&legKey=${spec.legKey}`;
  const before = await fs("GET", legQuery);
  if (before.status !== 200) throw new Error(`leg read failed ${before.status} ${JSON.stringify(before.payload)}`);
  const current = before.payload.assignments.find((a) => a.workflowDynastySlug === forkDynasty);
  if (current?.state === "active") {
    console.log(`leg ${spec.legKey}: ${forkDynasty} already active (decided by ${current.decidedBy})`);
    return;
  }
  const assigned = await fs("PUT", "/internal/workflow-leg-assignments", {
    featureSlug: FEATURE_SLUG,
    legKey: spec.legKey,
    workflowDynastySlug: forkDynasty,
    state: "active",
    decidedBy: DECIDED_BY,
    note: spec.legNote,
  });
  if (assigned.status !== 200) {
    throw new Error(`leg assignment failed ${assigned.status} ${JSON.stringify(assigned.payload)}`);
  }
  const after = await fs("GET", legQuery);
  if (after.status !== 200) throw new Error(`leg re-read failed ${after.status} ${JSON.stringify(after.payload)}`);
  const moved = otherAssignmentsMoved(before.payload.assignments, after.payload.assignments, forkDynasty);
  if (moved.length > 0) throw new Error(`other assignments moved during the write: ${moved.join(", ")}`);
  console.log(
    `leg ${spec.legKey}: ${forkDynasty} assigned active (was ${assigned.payload.previousState ?? "unassigned"}); ` +
    `${before.payload.assignments.length - (current ? 1 : 0)} other assignment(s) unchanged`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runFork(SPEC);
}
