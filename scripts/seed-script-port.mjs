#!/usr/bin/env node
/**
 * FACTORY-P2-ENGINES: store a PORTED script (code moved out of a repo into the database) with the recorded production
 * cases that prove it. Dry run by default, `--apply` to write; idempotent (cases upserted by id; the script created,
 * upgraded when its active code differs, else left alone). The cases hold real personal data: copy the file to the box,
 * run this inside the workflow-service container, delete the file after. Never commit a case file.
 *
 *   node scripts/seed-script-port.mjs --outcome message_written --dynasty dy_template_writer \
 *     --code /tmp/dy_template_writer.v1.ts --cases /tmp/message_written.json.gz \
 *     --source "gtm-factory-app@<sha> distribute/cases/message_written" \
 *     --description "..." [--tactics '{"llm":{"provider":"anthropic","model":"sonnet"}}'] [--apply]
 *
 * Env: WORKFLOW_SERVICE_API_KEY, ORG_ID, USER_ID, RUN_ID (a real staff identity: the creator), optional
 * WORKFLOW_URL (default http://localhost:${PORT:-3000}), STAFF_EMAIL (recorded as the author).
 */
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const apply = args.apply === true;
for (const k of ["outcome", "dynasty", "code", "cases", "source", "description"]) if (!args[k] || args[k] === true) throw new Error(`--${k} is required`);
const { WORKFLOW_SERVICE_API_KEY: key, ORG_ID, USER_ID, RUN_ID } = process.env;
if (!key || !ORG_ID || !USER_ID || !RUN_ID) throw new Error("WORKFLOW_SERVICE_API_KEY, ORG_ID, USER_ID and RUN_ID are required");
const base = (process.env.WORKFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
const identity = { "x-org-id": ORG_ID, "x-user-id": USER_ID, "x-run-id": RUN_ID, ...(process.env.STAFF_EMAIL ? { "x-email": process.env.STAFF_EMAIL } : {}) };

async function call(method, path, body, withIdentity = true) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", "x-api-key": key, ...(withIdentity ? identity : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

const code = readFileSync(args.code, "utf8");
const cases = JSON.parse(gunzipSync(readFileSync(args.cases)).toString("utf8"));
const tactics = args.tactics && args.tactics !== true ? JSON.parse(args.tactics) : undefined;
const dyn = `/scripts/dynasty/${args.outcome}/${args.dynasty}`;
console.log(`${args.outcome}/${args.dynasty}: ${cases.length} cases, ${code.length} chars of code${apply ? "" : " (dry run)"}`);

if (apply) {
  for (let i = 0; i < cases.length; i += 8) {
    const r = await call("PUT", `/internal${dyn}/cases`, { source: args.source, cases: cases.slice(i, i + 8) }, false);
    if (r.status !== 200) throw new Error(`cases ${i}: ${r.status} ${r.text.slice(0, 300)}`);
    console.log(`  cases stored, total ${r.json.total}`);
  }
}

const current = await call("GET", dyn);
if (current.status === 404) {
  console.log(`  no dynasty yet: ${apply ? "creating" : "would create"} v1`);
  if (apply) {
    const r = await call("POST", "/scripts", { outcome: args.outcome, dynasty: args.dynasty, code, description: args.description, ...(tactics ? { tactics } : {}) });
    console.log(`  -> ${r.status} ${r.json?.scriptSlug ?? r.text.slice(0, 500)} replay=${JSON.stringify(r.json?.replay ?? r.json?.details?.replay ?? null)}`);
    if (r.status !== 201) process.exit(1);
  }
} else if (current.status === 200) {
  const active = current.json.versions.find((v) => v.runnable);
  const full = active ? await call("GET", `/scripts/${active.id}`) : null;
  if (full && full.json.code === code) {
    console.log(`  ${active.scriptSlug} already runs this code (replay ${JSON.stringify(active.replay)}, ${current.json.cases} cases)`);
  } else {
    console.log(`  ${apply ? "upgrading" : "would upgrade"} ${active?.scriptSlug ?? "(no active version)"}`);
    if (apply) {
      const r = await call("POST", `${dyn}/upgrade`, { code, description: args.description, ...(tactics ? { tactics } : {}) });
      console.log(`  -> ${r.status} ${r.json?.scriptSlug ?? r.text.slice(0, 500)} replay=${JSON.stringify(r.json?.replay ?? r.json?.details?.replay ?? null)}`);
      if (r.status !== 201) process.exit(1);
    }
  }
} else {
  throw new Error(`GET ${dyn}: ${current.status} ${current.text.slice(0, 300)}`);
}
