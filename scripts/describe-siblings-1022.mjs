#!/usr/bin/env node
/**
 * BEST-TPL-LLM-1022 follow-up — workflows sharing a pipe read apart on the staff Research list: each executable
 * workflow's description OPENS with what makes it different from its pipe siblings (its own steps, the facts it feeds
 * the writer, who it serves, its sequence rules), read off a diff of their DAGs, never the boilerplate they share.
 *
 * Per pipe (features-service active leg) with two or more executable workflows: every DAG is flattened into facts
 * (nodes, stated body values, mappings, edges), the facts ALL siblings share are removed, and chat-service writes the
 * whole pipe's descriptions in ONE call so it can contrast them. Each must pass `descriptionProblem` and open
 * differently from its siblings (three tries, else the pipe is reported and left). Two workflows whose fact sets are
 * equal are twins: reported for a merge, never described. Written through `PUT /workflows/{id}` (metadata only).
 *
 * Usage (inside the workflow-service container): node scripts/describe-siblings-1022.mjs [--features a,b] [--apply]
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, CHAT_SERVICE_URL, CHAT_SERVICE_API_KEY,
 *      ORG_ID + USER_ID + RUN_ID (a REAL staff org, user and run), WORKFLOW_SERVICE_LOCAL_URL
 */
import { pathToFileURL } from "node:url";

export const DEFAULT_FEATURES = [
  "sales-cold-email-outreach", "feedback-request-cold-email-outreach", "ai-follow-up-email", "ai-meeting-booking", "cold-whatsapp-outreach",
  "lead-sourcing", "sourcing-crm-contacts", "sourcing-apollo-cold-filters", "sourcing-apollo-buying-signals", "sourcing-linkedin-engagement-signals",
  "pr-cold-email-outreach", "ai-instant-call", "email-sending", "social-post", "ai-lead-proposal",
];

/** A DAG as a set of facts: nodes, stated body/params values, mappings, edges (script code by length only). */
export function dagFacts(dag) {
  const out = new Set();
  for (const n of dag?.nodes ?? []) {
    const c = n.config ?? {};
    out.add(`step ${n.id}: ${n.type} ${c.method ?? ""} ${c.service ?? ""} ${c.path ?? ""}`.replace(/\s+/g, " ").trim());
    const walk = (o, p) => {
      if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
      else out.add(`${n.id}${p} = ${JSON.stringify(o)}`);
    };
    if (c.body) walk(c.body, ".body");
    if (c.params) walk(c.params, ".params");
    if (typeof c.code === "string") out.add(`${n.id} script of ${c.code.length} chars`);
    for (const [k, v] of Object.entries(n.inputMapping ?? {})) out.add(`${n.id} ${k} <- ${v}`);
  }
  for (const e of dag?.edges ?? []) out.add(`edge ${e.from} -> ${e.to}${e.condition ? ` if ${e.condition}` : ""}`);
  return out;
}

/** Per sibling, the facts it holds that not every sibling holds; and the twin groups (equal fact sets). */
export function siblingDiffs(workflows) {
  const F = workflows.map((w) => dagFacts(w.dag));
  const common = new Set([...F[0]].filter((x) => F.every((s) => s.has(x))));
  const own = workflows.map((w, i) => ({ workflow: w, own: [...F[i]].filter((x) => !common.has(x)) }));
  const twins = [];
  workflows.forEach((w, i) => {
    workflows.forEach((o, j) => {
      if (j > i && F[i].size === F[j].size && [...F[i]].every((x) => F[j].has(x))) twins.push([w.workflowDynastySlug, o.workflowDynastySlug]);
    });
  });
  return { own, twins, shared: common.size };
}

/** A description's first sentence: what the staff read first, so no two siblings may share it. */
const opening = (d) => d.toLowerCase().split(/(?<=[.!?])\s+/)[0];

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
  const i = process.argv.indexOf("--features");
  const FEATURES = i === -1 ? DEFAULT_FEATURES : process.argv[i + 1].split(",");
  const APPLY = process.argv.includes("--apply");
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const { WORKFLOW_SERVICE_API_KEY: WS_KEY, FEATURES_SERVICE_URL: FS, FEATURES_SERVICE_API_KEY: FS_KEY, CHAT_SERVICE_URL: CHAT, CHAT_SERVICE_API_KEY: CHAT_KEY, ORG_ID, USER_ID, RUN_ID } = process.env;
  const ours = { "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID };
  const system =
    `You write the descriptions of several workflows that run on the SAME pipe, shown side by side to the staff who pick between them. ` +
    `Each description must OPEN with what makes that workflow different from its siblings, read from its own facts below (the facts every sibling shares are already removed): ` +
    `extra steps it runs, the brand or lead facts it feeds the writer, who it serves or skips, its sequence or timing rules. ` +
    `Ignore differences that change nothing for the person reached (which internal address reads the same brand data, the order of the same fields). ` +
    `Platform facts: every email workflow sends a whole sequence (a first email and its follow-ups) whose wording, angle and length are chosen per run, so never call one a "discovery", "click-focused" or "single" email and ignore send tags; a sourcing workflow (a lead serve, no send) writes to nobody, it only finds people. ` +
    `Never repeat what they all do (taking the next lead, stopping when none is left, writing and sending the sequence). ${DESCRIPTION_RULES} ` +
    `No two descriptions may open with the same words. Write AT MOST TWO sentences each, never the word "template". ` +
    `Answer JSON {"descriptions": [{"workflowSlug": "...", "description": "..."}]} with one entry per workflow.`;
  const schema = {
    type: "object", additionalProperties: false, required: ["descriptions"],
    properties: { descriptions: { type: "array", items: { type: "object", additionalProperties: false, required: ["workflowSlug", "description"], properties: { workflowSlug: { type: "string" }, description: { type: "string" } } } } },
  };
  const report = { written: 0, pipes: 0, twins: [], failed: [] };

  for (const featureSlug of FEATURES) {
    const a = await call(FS, FS_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${featureSlug}`);
    const defs = await call(WS, WS_KEY, "GET", `/public/workflows/definitions?featureSlug=${featureSlug}`);
    if (a.status !== 200 || defs.status !== 200) throw new Error(`${featureSlug}: assignments ${a.status}, definitions ${defs.status}`);
    const live = defs.body.workflows.filter((w) => w.executable);
    const legs = new Map();
    for (const x of a.body.assignments.filter((x) => x.state === "active")) legs.set(x.legKey, [...(legs.get(x.legKey) ?? []), x.workflowDynastySlug]);
    for (const [legKey, dynasties] of legs) {
      const siblings = live.filter((w) => dynasties.includes(w.workflowDynastySlug));
      if (siblings.length < 2) continue;
      report.pipes++;
      const { own, twins } = siblingDiffs(siblings);
      for (const t of twins) report.twins.push(`${featureSlug}|${legKey}: ${t.join(" = ")}`);
      const message = `Pipe: ${featureSlug}|${legKey}\n` + own.map((o) => `## ${o.workflow.workflowSlug}\nOwn facts:\n${o.own.slice(0, 80).join("\n") || "(none)"}`).join("\n\n");
      let accepted = null;
      let problem = "";
      for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
        const res = await call(CHAT, CHAT_KEY, "POST", "/complete", { provider: "anthropic", model: "sonnet", systemPrompt: system, message: message + (attempt ? `\n\nYour previous answer was refused: ${problem}. Fix that.` : ""), responseFormat: "json", responseSchema: schema, maxTokens: 3000 }, ours);
        if (res.status !== 200) { problem = `chat ${res.status}`; continue; }
        const list = (res.body.json?.descriptions ?? []).map((d) => ({ slug: d.workflowSlug, text: plainDescription(String(d.description ?? "")) }));
        const missing = siblings.filter((w) => !list.some((d) => d.slug === w.workflowSlug)).map((w) => w.workflowSlug);
        const bad = list.map((d) => [d.slug, descriptionProblem(d.text)]).filter(([, p]) => p);
        const opens = list.map((d) => opening(d.text));
        if (missing.length) problem = `missing ${missing.join(", ")}`;
        else if (bad.length) problem = bad.map(([s, p]) => `${s} ${p}`).join("; ");
        else if (new Set(opens).size !== opens.length) {
          const dup = list.filter((d, k) => opens.indexOf(opens[k]) !== k || opens.lastIndexOf(opens[k]) !== k).map((d) => d.slug);
          problem = `${dup.join(" and ")} open with the same sentence: start each with its OWN difference`;
        }
        else accepted = list;
      }
      if (!accepted) { report.failed.push(`${featureSlug}|${legKey}: ${problem}`); continue; }
      for (const d of accepted) {
        const w = siblings.find((s) => s.workflowSlug === d.slug);
        console.log(`[${featureSlug}|${legKey}] ${d.slug}: ${d.text}`);
        if (!APPLY) continue;
        const put = await call(WS, WS_KEY, "PUT", `/workflows/${w.id}`, { description: d.text }, ours);
        if (put.status === 200) report.written++;
        else report.failed.push(`${d.slug}: PUT ${put.status}`);
      }
    }
  }
  console.log(`\npipes with siblings ${report.pipes}, written ${report.written}, twins ${report.twins.length}, failed ${report.failed.length}`);
  for (const t of report.twins) console.log(`  TWINS ${t}`);
  for (const f of report.failed) console.log(`  FAILED ${f}`);
  if (report.failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
