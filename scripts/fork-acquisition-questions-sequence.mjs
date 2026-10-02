#!/usr/bin/env node
/**
 * Ops script: ship the "acquisition questions" cold-email sequence as a NEW
 * dynasty on `sales-cold-email-outreach`, running on `glm-pro` (chat-service's
 * alias for GLM-5.3; owner's pick, 2026-10-03).
 *
 * The sequence is INSPIRED by `blind-discovery-email-v26` (the best template by
 * cost per positive reply with real volume): peer tone, one idea per line, a
 * light one-line ask, nothing invented, follow-ups with a fresh angle. It keeps
 * the TRUE blind discipline of `blind-discovery-email-v15` (owner amendment,
 * 2026-10-03): no `{{brands}}` data in the prompt at all, the brand intel is
 * headed internal-only, and neither the client's name nor its URL is ever
 * written. Where it
 * differs is the frame. We introduce ourselves as working on customer
 * acquisition for businesses like the prospect's and ask two questions a busy
 * owner answers in one line: what they would charge per person for a
 * hypothetical group on ONE specific service, and what happens today when a
 * customer calls while they are busy. Their answers ARE the pitch, which is
 * why the AI meeting booking responder carries a playbook for threads opened
 * by this sequence (`ACQUISITION_QUESTIONS_PLAYBOOK` in
 * `src/lib/ai-meeting-booking-dag.ts`). Keep the two texts in agreement.
 *
 * Two halves, in this order, same discipline as
 * `fork-dynasty-with-landing-page.mjs`:
 *
 *  1. The TEMPLATE. Its text lives HERE (`TEMPLATE_PROMPT`), owner-approved,
 *     and is stored in content-generation through `POST /platform-prompts`.
 *     That route no-ops on an existing type, so an existing template is
 *     COMPARED with what this file states and a drift is reported, never
 *     silently trusted. Variable DESCRIPTIONS are read off v26, which states
 *     every token this body uses, rather than restated here (v15 stores the
 *     same names with EMPTY descriptions, which `buildTemplate` refuses).
 *  2. The WORKFLOW. The source DAG is the active head of a `glm-pro`
 *     blind-discovery dynasty (default `sales-cold-email-outreach-nobelium`), resolved by
 *     dynasty slug at run time — heads move, a stored id goes stale. Only the
 *     content call changes (`body.type`, `body.model`), so every repair the
 *     head carries (lead refs, recipient context, timezone, end-run split)
 *     comes along. A changed signature on `PUT /workflows/:id` is the FORK path:
 *     the source stays active and the fork starts a new dynasty at version 1.
 *
 * The new dynasty is NOT assigned to any leg. Leg assignment is the owner's
 * decision in features-service; nothing here touches it.
 *
 * Idempotent: a re-run finds the template stored and the fork answering 409
 * with the existing workflow, and says so.
 *
 * Usage (inside the workflow-service container, against dist):
 *
 *   node fork-acquisition-questions-sequence.mjs --org <uuid>
 *   node fork-acquisition-questions-sequence.mjs --org <uuid> --apply
 *   [--dynasty <source dynasty slug>]
 *
 * The org must own the source workflow: a fork takes its org from the
 * caller's `x-org-id`.
 *
 * Env: WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL,
 *      CONTENT_GENERATION_SERVICE_API_KEY (all required), BASE_URL (default
 *      http://localhost:8080).
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const FEATURE_SLUG = "sales-cold-email-outreach";
export const TEMPLATE_TYPE = "acquisition-questions-email-v1";
export const DESCRIPTION_SOURCE_TYPE = "blind-discovery-email-v26";
export const MODEL = "glm-pro";
export const DEFAULT_SOURCE_DYNASTY = "sales-cold-email-outreach-nobelium";

export const WORKFLOW_DESCRIPTION =
  "Cold-email sequence that introduces us as a customer acquisition agency and asks two one-line questions: " +
  "what the prospect would charge per person for a hypothetical group on one specific service, and what happens " +
  "today when a customer calls while they are busy. Never names the client's product. Inspired by " +
  "blind-discovery-email-v26, blind like blind-discovery-email-v15 (never names the client or its URL), runs on GLM-5.3.";

/**
 * Owner-approved text (2026-10-03), with the owner's amendment applied: v15's
 * blind rules (no `{{brands}}` line, internal-only brand intel, never the
 * client's name or URL). v15's own header carries an em dash; it is written
 * here with a comma, because a model copies the dashes its prompt models.
 */
export const TEMPLATE_PROMPT = `Today is {{currentDate}}.

You're writing a 3-email cold sequence on behalf of a patient/customer acquisition agency. The prospect is a business that sells to its own customers (a dental clinic selling treatments, a garage selling repairs, a B2B vendor selling to accounts). The goal is a reply, not a sale.

## The frame
You work on bringing customers to businesses like the prospect's. You ask two concrete questions a busy owner answers in one line:
1. A price question about ONE specific offer they sell, framed as a hypothetical volume: "If I sent you 10 people for [specific service], what would you charge per person?"
2. A question about how they catch demand today, tied to the problem the client's product solves. Example for missed calls: "When someone calls [their number] while you're with a patient, do they reach voicemail, a receptionist, or an AI?"

Pick the specific service from the prospect's own description or keywords. If none is clear, use the most common offer for their industry.

## Honesty rules (non-negotiable)
- Say who you are in one line in email 1: you work on customer acquisition for businesses like theirs.
- The volume is a HYPOTHETICAL. Never claim you have a group, a list, or people waiting. Never say anyone chose, called, or visited them.
- Never invent a number, a client, or a result. Use only the brand intel.
- Never name the client's product or brand, or its URL, in this sequence. That comes after they reply.

## Tone and shape
A real person writing to a peer. Warm, short, direct. "Hey Sophie," or "Sophie,". Contractions, fragments.
One idea per paragraph, a line break between each. Email 1 under 80 words. Never use an em dash or en dash.
Kills it: marketing voice, "I noticed that", "I came across", flattery welded onto the ask, any sentence that could go to 1000 prospects unchanged.

## The sequence
Email 1: who you are (one line), the two questions, nothing else. Subject: specific and human, mentions the service (e.g. "whitening, 10 patients").
Email 2 (~3 days, same thread): one fresh angle on why the answer matters to them (ONLY with facts the brand intel states). Re-ask the shorter of the two questions.
Email 3 (~7 days, same thread): two lines. Close the loop, leave the door open.

## Data hygiene
Normalize ALL CAPS names to title case. Skip weak signals that would sound robotic.

## Prospect
- Name: {{leadFirstName}} {{leadLastName}}
- LinkedIn Headline: {{leadHeadline}}
- Company: {{leadCompanyName}}
- Industry: {{leadCompanyIndustry}}
- Company Size: {{leadCompanySize}}
- Company Description: {{leadCompanyDescription}}
- Keywords: {{leadCompanyKeywords}}

## Brand Intelligence (internal only, never reveal the client name or URL)
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
export function buildTemplate(descriptionSource) {
  const described = new Map((descriptionSource.variables ?? []).map((v) => [v.name, v]));
  const variables = templateTokens(TEMPLATE_PROMPT).map((name) => {
    const v = described.get(name);
    if (!v || typeof v.description !== "string" || v.description.trim() === "") {
      throw new Error(
        `template "${descriptionSource.type}" carries no description for "{{${name}}}" — ` +
        `refusing to store "${TEMPLATE_TYPE}" with an undescribed variable`,
      );
    }
    return { name, description: v.description };
  });
  return { type: TEMPLATE_TYPE, prompt: TEMPLATE_PROMPT, variables };
}

/** The content-generation call: the only node in these DAGs posting to `/generate`. */
export function findGenerateNode(dag) {
  return dag.nodes.find((n) => n.config?.path === "/generate" && n.config?.body?.type);
}

/**
 * The source DAG with its content call pointed at the new template and model.
 * Every token the template states must already be mapped by the source, or the
 * fork would generate with a blank where a prospect fact belongs.
 */
export function withAcquisitionQuestions(dag) {
  const clone = structuredClone(dag);
  const node = findGenerateNode(clone);
  if (!node) throw new Error("no content-generation /generate node in DAG");
  const mapped = new Set(
    Object.keys(node.inputMapping ?? {})
      .map((k) => k.match(/^body\.variables\.(.+)$/)?.[1])
      .filter(Boolean),
  );
  const unmapped = templateTokens(TEMPLATE_PROMPT).filter((t) => !mapped.has(t));
  if (unmapped.length > 0) {
    throw new Error(`source DAG does not map ${JSON.stringify(unmapped)} on its content call`);
  }
  node.config.body.type = TEMPLATE_TYPE;
  node.config.body.model = MODEL;
  return clone;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function main() {
  const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
  const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
  const CG_URL = process.env.CONTENT_GENERATION_SERVICE_URL;
  const CG_KEY = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
  const APPLY = process.argv.includes("--apply");
  const ORG_ID = arg("org");
  const DYNASTY = arg("dynasty") ?? DEFAULT_SOURCE_DYNASTY;

  if (!API_KEY || !CG_URL || !CG_KEY) {
    console.error("WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL and CONTENT_GENERATION_SERVICE_API_KEY are required");
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

  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");

  // 1. The template, BEFORE the workflow: a DAG naming a type content-generation
  //    has never stored is a workflow that 404s on its first run.
  const source = await cg("GET", `/platform-prompts?type=${encodeURIComponent(DESCRIPTION_SOURCE_TYPE)}`);
  if (source.status !== 200) {
    throw new Error(`description source ${DESCRIPTION_SOURCE_TYPE} unreadable (${source.status})`);
  }
  const template = buildTemplate(source.payload);
  const existing = await cg("GET", `/platform-prompts?type=${encodeURIComponent(TEMPLATE_TYPE)}`);
  if (existing.status === 200) {
    if (existing.payload.prompt !== TEMPLATE_PROMPT) {
      throw new Error(`template ${TEMPLATE_TYPE} is stored but DIFFERS from this file; refusing to fork onto it`);
    }
    console.log(`template ${TEMPLATE_TYPE}: already stored, matches this file`);
  } else if (!APPLY) {
    console.log(`template ${TEMPLATE_TYPE}: would create (${template.prompt.length} chars, variables ${template.variables.map((v) => v.name).join(",")})`);
  } else {
    const created = await cg("POST", "/platform-prompts", template);
    if (created.status !== 201 && created.status !== 200) {
      throw new Error(`creating ${TEMPLATE_TYPE} failed ${created.status} ${JSON.stringify(created.payload)}`);
    }
    console.log(`template ${TEMPLATE_TYPE}: created`);
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
  const dag = withAcquisitionQuestions(got.payload.dag);
  console.log(`source: ${got.payload.workflowSlug} (${got.payload.id}), template ${findGenerateNode(got.payload.dag).config.body.type}`);

  if (!APPLY) {
    console.log(`would fork onto ${TEMPLATE_TYPE} / ${MODEL}`);
    return;
  }
  const put = await wf("PUT", `/workflows/${got.payload.id}`, { dag, description: WORKFLOW_DESCRIPTION });
  if (put.status === 201) {
    console.log(`created ${put.payload.workflowSlug} (dynasty ${put.payload.workflowDynastySlug}, id ${put.payload.id})`);
  } else if (put.status === 409) {
    console.log(`already covered by ${put.payload.existingWorkflowSlug ?? JSON.stringify(put.payload)}`);
  } else {
    throw new Error(`fork failed ${put.status} ${JSON.stringify(put.payload)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
