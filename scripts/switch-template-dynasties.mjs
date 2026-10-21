#!/usr/bin/env node
/**
 * TPL-DYNASTY-1021-WF — every active workflow writes with a template DYNASTY (its live head), never a version.
 *
 * For each executable dynasty of the channels content-generation keeps template dynasties for, on each pipe
 * (features-service active leg) it serves: find the template dynasty OF THAT PIPE whose versions hold the template
 * the workflow runs today, and UPGRADE the workflow (never a fork) to read that dynasty's head at run time
 * (`withTemplateDynasty`, src/lib/template-dynasty.ts). The upgrade writes with the CURRENT head, so a workflow
 * on an older version of its dynasty moves to the head (owner 2026-10-21). Variable mappings the head neither
 * declares nor accepts as context are dropped (they would be refused by the template contract check).
 *
 * Reported, never guessed: a workflow on no pipe, on several pipes, whose template no dynasty of its pipe holds,
 * or whose upgrade is refused (a 409 duplicate_on_pipe = merge its twin first). Idempotent: a workflow already
 * reading the right dynasty is skipped.
 *
 * Usage (inside the workflow-service container, its own env, after `npm run build`):
 *   node scripts/switch-template-dynasties.mjs                 # dry run
 *   node scripts/switch-template-dynasties.mjs --apply [--only <dynasty>,<dynasty>]
 * Env: FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL,
 *      CONTENT_GENERATION_SERVICE_API_KEY, UPGRADE_USER_ID (a real staff user id), WORKFLOW_SERVICE_LOCAL_URL
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const FEATURE_SLUGS = ["sales-cold-email-outreach", "feedback-request-cold-email-outreach"];
const TEMPLATE_HEAD_NODE_ID = "template-head";

const isGenerate = (n) => n?.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate";

/** The template a DAG pins (the static base when it already reads a head). */
export function pinnedType(dag) {
  const gens = dag.nodes.filter(isGenerate);
  if (gens.length !== 1) return null;
  const mapped = gens[0].inputMapping?.["body.type"];
  if (typeof mapped === "string" && !mapped.startsWith("$ref:")) return mapped;
  return typeof gens[0].config?.body?.type === "string" ? gens[0].config.body.type : null;
}

export function statedDynasty(dag) {
  const head = dag.nodes.find((n) => n.id === TEMPLATE_HEAD_NODE_ID);
  return head?.config?.params?.slug ?? null;
}

/** The DAG minus the `body.variables.*` mappings the head neither declares nor accepts as context. */
export function dropUnknownVariables(dag, accepted) {
  const copy = structuredClone(dag);
  const dropped = [];
  const gen = copy.nodes.find(isGenerate);
  for (const key of Object.keys(gen.inputMapping ?? {})) {
    const m = key.match(/^body\.variables\.([^.]+)$/);
    if (m && !accepted.has(m[1])) {
      delete gen.inputMapping[key];
      dropped.push(m[1]);
    }
  }
  for (const name of Object.keys(gen.config?.body?.variables ?? {})) {
    if (!accepted.has(name)) {
      delete gen.config.body.variables[name];
      dropped.push(name);
    }
  }
  return { dag: copy, dropped };
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
  const { withTemplateDynasty } = await import(new URL("../dist/lib/template-dynasty.js", import.meta.url).href);
  const APPLY = process.argv.includes("--apply");
  const ONLY = (() => {
    const i = process.argv.indexOf("--only");
    return i === -1 ? null : process.argv[i + 1].split(",");
  })();
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const { WORKFLOW_SERVICE_API_KEY: WS_KEY, CONTENT_GENERATION_SERVICE_URL: CG, CONTENT_GENERATION_SERVICE_API_KEY: CG_KEY, UPGRADE_USER_ID } = process.env;
  if (!WS_KEY || !CG || !CG_KEY || !UPGRADE_USER_ID) throw new Error("WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL, CONTENT_GENERATION_SERVICE_API_KEY and UPGRADE_USER_ID are required");
  const identity = (orgId) => ({ "x-org-id": orgId, "x-user-id": UPGRADE_USER_ID, "x-run-id": randomUUID() });
  const report = { switched: [], skipped: [], notSwitched: [] };

  for (const featureSlug of FEATURE_SLUGS) {
    const fs = await call(process.env.FEATURES_SERVICE_URL, process.env.FEATURES_SERVICE_API_KEY, "GET", `/internal/workflow-leg-assignments?featureSlug=${featureSlug}`);
    if (fs.status !== 200) throw new Error(`features-service assignments ${featureSlug}: ${fs.status}`);
    const listed = await call(WS, WS_KEY, "GET", `/workflows/summaries?featureSlug=${featureSlug}&status=active`, undefined, identity(randomUUID()));
    if (listed.status !== 200) throw new Error(`summaries ${featureSlug}: ${listed.status}`);
    const dynastiesByLeg = new Map();

    for (const summary of listed.body.workflows ?? listed.body) {
      const slug = summary.workflowDynastySlug;
      if (ONLY && !ONLY.includes(slug)) continue;
      const note = (reason) => report.notSwitched.push({ workflow: summary.workflowSlug, reason });
      try {
        const legs = [...new Set(fs.body.assignments.filter((a) => a.workflowDynastySlug === slug && a.state === "active").map((a) => a.legKey))];
        if (legs.length !== 1) {
          note(legs.length === 0 ? "on no pipe (no active leg)" : `on several pipes (${legs.join(", ")})`);
          continue;
        }
        const legKey = legs[0];
        if (!dynastiesByLeg.has(legKey)) {
          const d = await call(CG, CG_KEY, "GET", `/internal/template-dynasties?featureSlug=${featureSlug}&legKey=${legKey}`);
          if (d.status !== 200) throw new Error(`template dynasties ${featureSlug}|${legKey}: ${d.status}`);
          dynastiesByLeg.set(legKey, d.body.dynasties);
        }
        const wf = (await call(WS, WS_KEY, "GET", `/workflows/${summary.id}`, undefined, identity(randomUUID()))).body;
        const type = pinnedType(wf.dag);
        if (!type) {
          note("writes no single email template");
          continue;
        }
        const dynasty = dynastiesByLeg.get(legKey).find((d) => d.versions.some((v) => v.type === type));
        if (!dynasty) {
          note(`template ${type} is in no template dynasty of ${featureSlug}|${legKey}`);
          continue;
        }
        const head = await call(CG, CG_KEY, "GET", `/internal/template-dynasties/${dynasty.slug}/head`);
        if (head.status !== 200) throw new Error(`head of ${dynasty.slug}: ${head.status}`);
        const headType = head.body.template.type;
        if (statedDynasty(wf.dag) === dynasty.slug && type === headType) {
          report.skipped.push({ workflow: wf.workflowSlug, dynasty: dynasty.slug });
          continue;
        }
        let context = head.body.template.contextVariables;
        if (!context) context = (await call(CG, CG_KEY, "GET", `/platform-prompts?type=${encodeURIComponent(headType)}`)).body.contextVariables ?? [];
        const accepted = new Set([...head.body.template.variables, ...context].map((v) => v.name));
        const { dag: trimmed, dropped } = dropUnknownVariables(wf.dag, accepted);
        const dag = withTemplateDynasty(trimmed, dynasty.slug, headType);
        const line = `${wf.workflowSlug} (${legKey}): ${type} -> dynasty ${dynasty.slug} (head ${headType})${dropped.length ? `, drops ${dropped.join(", ")}` : ""}`;
        if (!APPLY) {
          console.log(`would switch ${line}`);
          report.switched.push(line);
          continue;
        }
        const up = await call(WS, WS_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: slug, dag }, identity(wf.orgId));
        if (up.status !== 201 && up.status !== 200) {
          note(`upgrade refused ${up.status}: ${JSON.stringify(up.body).slice(0, 400)}`);
          continue;
        }
        console.log(`switched ${line} -> ${up.body.workflow?.workflowSlug ?? "(updated in place)"}`);
        report.switched.push(line);
        await new Promise((r) => setTimeout(r, 7000)); // createRateLimit: 10 per minute per org
      } catch (err) {
        note(`error: ${err.message}`);
      }
    }
  }
  console.log(`\nswitched ${report.switched.length}, already on their dynasty ${report.skipped.length}, not switched ${report.notSwitched.length}`);
  for (const n of report.notSwitched) console.log(`  NOT SWITCHED ${n.workflow}: ${n.reason}`);
  if (report.notSwitched.some((n) => n.reason.startsWith("error") || n.reason.startsWith("upgrade refused"))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
