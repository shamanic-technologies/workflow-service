#!/usr/bin/env node
/**
 * BEST-TPL-LLM-1022 follow-up — every workflow's description (active AND deprecated) says what its sequence DOES, in
 * plain English (`DESCRIPTION_RULES`, src/lib/plain-description.ts): shape, follow-ups, delays, tactic, and every rule
 * about who it reaches. No template, model, test, version or date (a workflow fixes no template nor LLM any more),
 * no em/en dash. The staff Research page shows it verbatim, and features-service judges tactics on it.
 *
 * Rows are grouped by (old description, the DAG's shape): chat-service writes ONE description per group from the DAG
 * and the old text, checked by `descriptionProblem` (one retry, else reported and left as it was). Each row is then
 * written through `PUT /workflows/{id}` (metadata only, nothing else moves). Idempotent: a row whose description
 * already reads right is skipped.
 *
 * Usage (inside the workflow-service container, after `npm run build`):
 *   node scripts/rewrite-descriptions-1022.mjs [--features a,b] [--limit N] [--cache /tmp/x.json] [--apply]
 * `--cache` keeps each group's accepted text, so the apply writes exactly what the dry run printed (no second model call).
 * Env: WORKFLOW_SERVICE_API_KEY, CHAT_SERVICE_URL, CHAT_SERVICE_API_KEY, ORG_ID + USER_ID + RUN_ID (a REAL staff
 *      org, user and run: the model spend is ours), WORKFLOW_SERVICE_LOCAL_URL
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const DEFAULT_FEATURES = [
  "sales-cold-email-outreach", "pr-cold-email-outreach", "ai-meeting-booking", "feedback-request-cold-email-outreach", "ai-follow-up-email",
  "pr-expert-quote-outreach", "press-kit-page-generation", "cold-whatsapp-outreach", "pr-expert-quote-opportunities", "lead-sourcing",
  "ai-visibility-scoring", "sales-crm-email-outreach", "sourcing-crm-contacts", "ai-instant-call", "vc-cold-email-outreach", "hiring-cold-email-outreach",
  "social-post", "email-sending", "sourcing-apollo-cold-filters", "sourcing-linkedin-engagement-signals", "sourcing-apollo-buying-signals",
  "ai-lead-proposal", "google-ads", "outlet-database-discovery", "meta-ads",
];

const CODE_CAP = 1500;

/** What the model reads of a DAG: every node's role and its stated settings, script code cut short; no prompts. */
export function dagShape(dag) {
  const nodes = (dag?.nodes ?? []).map((n) => {
    const c = n.config ?? {};
    const out = { id: n.id, type: n.type };
    if (c.service) out.call = `${c.method ?? ""} ${c.service} ${c.path ?? ""}`.trim();
    if (c.body && typeof c.body === "object") {
      const { systemPrompt: _s, responseSchema: _r, message: _m, provider: _p, model: _mo, type: _t, ...rest } = c.body;
      if (Object.keys(rest).length) out.body = rest;
    }
    if (typeof c.code === "string") out.code = c.code.slice(0, CODE_CAP);
    if (c.seconds !== undefined || c.delay !== undefined) out.wait = c.seconds ?? c.delay;
    return out;
  });
  return { nodes, edges: (dag?.edges ?? []).map((e) => `${e.from}->${e.to}${e.condition ? ` [${e.condition}]` : ""}`) };
}

export function groupKey(description, dag) {
  return createHash("sha256").update(JSON.stringify([description ?? "", dagShape(dag)])).digest("hex");
}

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
  const { DESCRIPTION_RULES, plainDescription, descriptionProblem } = await import(new URL("../dist/lib/plain-description.js", import.meta.url).href);
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1];
  };
  const APPLY = process.argv.includes("--apply");
  // An apply with a cache writes only what the dry run accepted: a group with no cached text is reported, not drafted.
  const APPLY_CACHED_ONLY = APPLY && process.argv.includes("--cache");
  const FEATURES = arg("--features")?.split(",") ?? DEFAULT_FEATURES;
  const LIMIT = arg("--limit") ? Number(arg("--limit")) : Infinity;
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const { WORKFLOW_SERVICE_API_KEY: WS_KEY, CHAT_SERVICE_URL: CHAT, CHAT_SERVICE_API_KEY: CHAT_KEY, ORG_ID, USER_ID, RUN_ID } = process.env;
  if (!WS_KEY || !CHAT || !CHAT_KEY || !ORG_ID || !USER_ID || !RUN_ID) throw new Error("WORKFLOW_SERVICE_API_KEY, CHAT_SERVICE_URL, CHAT_SERVICE_API_KEY, ORG_ID, USER_ID and RUN_ID are required");
  const ours = { "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };

  const rows = [];
  for (const featureSlug of FEATURES) {
    const r = await call(WS, WS_KEY, "GET", `/public/workflows/definitions?featureSlug=${featureSlug}`);
    if (r.status !== 200) throw new Error(`definitions ${featureSlug}: ${r.status}`);
    for (const w of r.body.workflows) rows.push({ ...w, featureSlug });
  }
  const todo = rows.filter((w) => !w.description || descriptionProblem(w.description) !== null);
  const groups = new Map();
  for (const w of todo) {
    const k = groupKey(w.description, w.dag);
    groups.set(k, [...(groups.get(k) ?? []), w]);
  }
  console.log(`${rows.length} workflows, ${todo.length} to rewrite, ${groups.size} distinct (description, shape) groups`);

  const system = `You write the one description a workflow shows to the staff who pick workflows. ${DESCRIPTION_RULES} Facts about the platform: a content-generation /generate call writes a whole email SEQUENCE (the first email and its follow-ups, their number and spacing set by the template picked each run) and email-gateway /orgs/send sends that sequence, so such a workflow sends a cold email sequence with follow-ups, never "a single email with no follow-ups"; a chat-service /complete call is the model writing one message. No internal words (buffer, run, node, campaign service, unit); when the workflow finds nobody it simply stops for now, never say it pauses or stops a campaign. Read the DAG to learn what it actually does; the old description may be stale, internal or wrong, keep only what the DAG confirms plus any rule about who it reaches. Write AT MOST TWO sentences (join rules with commas or a colon), and never the word "template". Answer JSON {"description": "..."}.`;
  const schema = { type: "object", additionalProperties: false, required: ["description"], properties: { description: { type: "string" } } };
  const report = { written: 0, skippedOk: rows.length - todo.length, failed: [] };
  const CACHE = arg("--cache");
  const cache = CACHE && existsSync(CACHE) ? JSON.parse(readFileSync(CACHE, "utf8")) : {};
  let n = 0;
  for (const [key, members] of groups) {
    if (n++ >= LIMIT) break;
    const w = members[0];
    let description = typeof cache[key] === "string" && descriptionProblem(cache[key]) === null ? cache[key] : null;
    let problem = "no answer";
    for (let attempt = 0; attempt < 3 && description === null && !APPLY_CACHED_ONLY; attempt++) {
      const message = `Channel: ${w.featureSlug}\nOld description: ${w.description ?? "(none)"}\nDAG: ${JSON.stringify(dagShape(w.dag))}${attempt ? `\nYour previous answer was refused: ${problem}. Fix that.` : ""}`;
      const res = await call(CHAT, CHAT_KEY, "POST", "/complete", { provider: "anthropic", model: "sonnet", systemPrompt: system, message, responseFormat: "json", responseSchema: schema, maxTokens: 400 }, ours);
      if (res.status !== 200) {
        problem = `chat ${res.status}`;
        continue;
      }
      const candidate = plainDescription(String(res.body.json?.description ?? ""));
      problem = descriptionProblem(candidate) ?? "";
      if (!problem) description = candidate;
    }
    if (description === null) {
      for (const m of members) report.failed.push(`${m.workflowSlug}: ${problem}`);
      continue;
    }
    if (CACHE) {
      cache[key] = description;
      writeFileSync(CACHE, JSON.stringify(cache));
    }
    console.log(`[${members.length}x] ${w.workflowSlug}: ${description}`);
    if (!APPLY) continue;
    for (const m of members) {
      const put = await call(WS, WS_KEY, "PUT", `/workflows/${m.id}`, { description }, { ...ours });
      if (put.status === 200) report.written++;
      else report.failed.push(`${m.workflowSlug}: PUT ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
    }
  }
  console.log(`\nwritten ${report.written}, already right ${report.skippedOk}, failed ${report.failed.length}`);
  for (const f of report.failed) console.log(`  FAILED ${f}`);
  if (report.failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
