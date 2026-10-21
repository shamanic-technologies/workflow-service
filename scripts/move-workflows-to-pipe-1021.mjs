#!/usr/bin/env node
/**
 * TPL-DYNASTY-1021-WF2 — move a workflow to the pipe its email serves (owner 2026-10-21).
 *
 * Each move is DATA (`MOVES`), never a code branch: a workflow dynasty, the leg it leaves, the leg it joins, and the
 * template dynasty OF THE NEW PIPE it writes with there. Per move, in this order:
 *   1. The leg: features-service owns which workflow serves which pipe. `PUT /internal/workflow-leg-assignments`
 *      deprecates the old leg, then activates the new one (one leg at a time: the reverse order is a 409), both with
 *      the reason as `note`, so the change reads in the leg-assignment history. Already on the new leg only = skipped.
 *   2. The template: an UPGRADE (never a fork) onto the new pipe's template dynasty head (`withTemplateDynasty`),
 *      dropping variable mappings the head neither declares nor accepts as context.
 *   3. The duplicate rule: when the upgrade answers 409 `duplicate_on_pipe`, an active workflow on the new pipe
 *      already writes with that template dynasty + model: the moved one is MERGED into it (survivor = the one already
 *      there, reversible: `.../unmerge`). A merged dynasty forwards its runs to the survivor, which writes with the
 *      new pipe's dynasty.
 * Idempotent: a dynasty already moved, upgraded or merged is skipped. The template dynasty left with no workflow on
 * the old pipe stays in content-generation's catalogue (nothing deleted).
 *
 * Usage (inside the workflow-service container, after `npm run build`):
 *   node scripts/move-workflows-to-pipe-1021.mjs            # dry run: reads and plans, writes nothing
 *   node scripts/move-workflows-to-pipe-1021.mjs --apply
 * Env: FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, WORKFLOW_SERVICE_API_KEY, CONTENT_GENERATION_SERVICE_URL,
 *      CONTENT_GENERATION_SERVICE_API_KEY, MOVE_ORG_ID + MOVE_USER_ID + MOVE_RUN_ID (a REAL staff run of our own org:
 *      never a placeholder identity), WORKFLOW_SERVICE_LOCAL_URL
 */

import { pathToFileURL } from "node:url";
import { dropUnknownVariables, pinnedType, statedDynasty } from "./switch-template-dynasties.mjs";

const FEATURE = "sales-cold-email-outreach";
const REPLY = "lead_found_to_conversation";
const VISIT = "lead_found_to_website_visit";
const WEBSITE = "Its email asks the prospect to visit the client's website: it serves Website visit, not Positive reply";
const INTRO = "Its email offers an intro and asks for an answer: it serves Positive reply, not Website visit";

export const MOVES = [
  // [dynasty, from leg, to leg, template dynasty of the new pipe, why]
  ["azha", REPLY, VISIT, "cold-click-website-click-named", WEBSITE],
  ["solaris", REPLY, VISIT, "cold-click-website-click-named", WEBSITE],
  ["uklun", REPLY, VISIT, "cold-click-website-click-named", WEBSITE],
  ["khambalia", VISIT, REPLY, "cold-reply-intro-offer-blind", INTRO],
].map(([d, fromLeg, toLeg, templateDynasty, why]) => ({
  featureSlug: FEATURE,
  dynasty: `${FEATURE}-${d}`,
  fromLeg,
  toLeg,
  templateDynasty,
  reason: `${why} (owner 2026-10-21, TPL-DYNASTY-1021-WF2).`,
}));

/**
 * What the leg step must write, from the dynasty's assignments: `done` when it is active on the new leg only,
 * `move` when active on the old leg only, otherwise a refusal naming what it found (never guessed).
 */
export function legPlan(assignments, move) {
  const active = [...new Set(assignments.filter((a) => a.workflowDynastySlug === move.dynasty && a.state === "active").map((a) => a.legKey))];
  if (active.length === 1 && active[0] === move.toLeg) return { kind: "done" };
  if (active.length === 1 && active[0] === move.fromLeg) return { kind: "move" };
  return { kind: "refused", reason: `active on [${active.join(", ") || "no leg"}], expected ${move.fromLeg} or ${move.toLeg} alone` };
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
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const env = process.env;
  for (const k of ["FEATURES_SERVICE_URL", "FEATURES_SERVICE_API_KEY", "WORKFLOW_SERVICE_API_KEY", "CONTENT_GENERATION_SERVICE_URL", "CONTENT_GENERATION_SERVICE_API_KEY", "MOVE_ORG_ID", "MOVE_USER_ID", "MOVE_RUN_ID"]) {
    if (!env[k]) throw new Error(`${k} is required`);
  }
  const staff = { "x-org-id": env.MOVE_ORG_ID, "x-user-id": env.MOVE_USER_ID, "x-run-id": env.MOVE_RUN_ID };
  const F = (method, path, body) => call(env.FEATURES_SERVICE_URL, env.FEATURES_SERVICE_API_KEY, method, path, body);
  const CG = (method, path) => call(env.CONTENT_GENERATION_SERVICE_URL, env.CONTENT_GENERATION_SERVICE_API_KEY, method, path);
  const W = (method, path, body, identity = staff) => call(WS, env.WORKFLOW_SERVICE_API_KEY, method, path, body, identity);
  let failed = 0;

  for (const m of MOVES) {
    const say = (s) => console.log(`${m.dynasty}: ${s}`);
    const fail = (s) => {
      failed++;
      say(`FAILED ${s}`);
    };
    const merges = await W("GET", `/public/workflows/dynasty-merges?featureSlug=${m.featureSlug}`);
    if (merges.status !== 200) throw new Error(`dynasty-merges: ${merges.status}`);
    const merged = merges.body.merges.find((x) => x.absorbedDynastySlug === m.dynasty);

    // 1. The leg.
    const a = await F("GET", `/internal/workflow-leg-assignments?featureSlug=${m.featureSlug}`);
    if (a.status !== 200) throw new Error(`leg assignments: ${a.status}`);
    const leg = legPlan(a.body.assignments, m);
    if (leg.kind === "refused") {
      fail(leg.reason);
      continue;
    }
    if (leg.kind === "move") {
      if (!APPLY) say(`would move ${m.fromLeg} -> ${m.toLeg}`);
      else {
        const put = (legKey, state) => F("PUT", "/internal/workflow-leg-assignments", { featureSlug: m.featureSlug, legKey, workflowDynastySlug: m.dynasty, state, decidedBy: "kevin@distribute.you", note: m.reason });
        const off = await put(m.fromLeg, "deprecated");
        if (off.status !== 200) {
          fail(`deprecating ${m.fromLeg}: ${off.status} ${JSON.stringify(off.body).slice(0, 300)}`);
          continue;
        }
        const on = await put(m.toLeg, "active");
        if (on.status !== 200) {
          fail(`activating ${m.toLeg}: ${on.status} ${JSON.stringify(on.body).slice(0, 300)} (old leg already deprecated: re-run after fixing)`);
          continue;
        }
        say(`moved ${m.fromLeg} -> ${m.toLeg}`);
      }
    } else say(`already on ${m.toLeg} only`);

    if (merged) {
      say(`already merged into ${merged.finalSurvivorDynastySlug}`);
      continue;
    }

    // 2. The template of the new pipe.
    const d = await CG("GET", `/internal/template-dynasties?featureSlug=${m.featureSlug}&legKey=${m.toLeg}`);
    if (d.status !== 200) throw new Error(`template dynasties of ${m.toLeg}: ${d.status}`);
    if (!d.body.dynasties.some((x) => x.slug === m.templateDynasty)) {
      fail(`template dynasty ${m.templateDynasty} is not one of ${m.featureSlug}|${m.toLeg}`);
      continue;
    }
    const head = await CG("GET", `/internal/template-dynasties/${m.templateDynasty}/head`);
    if (head.status !== 200) throw new Error(`head of ${m.templateDynasty}: ${head.status}`);
    const headType = head.body.template.type;
    const listed = await W("GET", `/workflows/summaries?featureSlug=${m.featureSlug}&workflowDynastySlug=${m.dynasty}&status=active`);
    const summary = (listed.body.workflows ?? [])[0];
    if (listed.status !== 200 || !summary) {
      fail(`no executable version (${listed.status})`);
      continue;
    }
    const wf = (await W("GET", `/workflows/${summary.id}`)).body;
    if (statedDynasty(wf.dag) === m.templateDynasty && pinnedType(wf.dag) === headType) {
      say(`already writes with ${m.templateDynasty}`);
      continue;
    }
    let context = head.body.template.contextVariables;
    if (!context) context = (await CG("GET", `/platform-prompts?type=${encodeURIComponent(headType)}`)).body.contextVariables ?? [];
    const accepted = new Set([...head.body.template.variables, ...context].map((v) => v.name));
    const { dag: trimmed, dropped } = dropUnknownVariables(wf.dag, accepted);
    const dag = withTemplateDynasty(trimmed, m.templateDynasty, headType);
    const line = `${pinnedType(wf.dag)} -> dynasty ${m.templateDynasty} (head ${headType})${dropped.length ? `, drops ${dropped.join(", ")}` : ""}`;
    if (!APPLY) {
      say(`would upgrade ${line} (or merge into its twin on ${m.toLeg})`);
      continue;
    }
    // The new version is written under the workflow's own org, never the caller's.
    const up = await W("POST", "/workflows/upgrade", { workflowDynastySlug: m.dynasty, dag }, { ...staff, "x-org-id": wf.orgId });
    if (up.status === 200 || up.status === 201) {
      say(`upgraded ${line} -> ${up.body.workflow?.workflowSlug ?? "(in place)"}`);
      continue;
    }
    // 3. The duplicate rule: the one already on the pipe survives.
    if (up.status === 409 && up.body?.code === "duplicate_on_pipe") {
      const twin = up.body.twinWorkflowDynastySlug;
      const mg = await W("POST", `/workflows/dynasty/${m.dynasty}/merge`, {
        intoWorkflowDynastySlug: twin,
        reason: `Moved to ${m.toLeg}, where ${twin} already writes with the same template dynasty and model: one workflow (owner 2026-10-21, TPL-DYNASTY-1021-WF2).`,
        decidedBy: "kevin@distribute.you",
      });
      if (mg.status !== 201) fail(`merge into ${twin}: ${mg.status} ${JSON.stringify(mg.body).slice(0, 300)}`);
      else say(`merged into ${twin} (same template dynasty + model on ${m.toLeg})`);
      continue;
    }
    fail(`upgrade refused ${up.status}: ${JSON.stringify(up.body).slice(0, 400)}`);
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
