#!/usr/bin/env node
/**
 * BEST-TPL-LLM-1022 — every live workflow stops fixing its template and its LLM: each run writes with the template
 * dynasty and the LLM features-service ranks best on its leg (`withLegBestWriter`, src/lib/leg-best-writer.ts).
 *
 * For each executable dynasty of the given channels whose DAG has exactly ONE content-generation /generate call:
 *   1. ask features-service for the leg's pick (`GET /internal/writer-pick?workflowSlug=`): a leg with no template or
 *      no LLM to pick (no template dynasty on the pipe, ranking not built...) is REPORTED and left as it is, since a
 *      freed workflow would then write nothing;
 *   2. UPGRADE the dynasty (new version, never a fork) to the freed DAG, its description stating the new rule;
 *   3. a 409 "same DAG signature" means another dynasty became the SAME workflow once freed (it differed only by the
 *      template/LLM it pinned): this dynasty is MERGED into it (non-destructive, reversible, execute forwards). When
 *      that twin serves ANOTHER pipe (merge refused `merge_across_pipes`), the freed DAG states its own pipe
 *      (`forkedForPipe`, inert) and the upgrade is retried: one workflow per pipe.
 * Idempotent: a dynasty already freed is skipped; an already-merged one answers 409 already_merged.
 *
 * Usage (inside the workflow-service container, after `npm run build`):
 *   node scripts/free-writers-1022.mjs [--features a,b] [--only <dynasty>,<dynasty>] [--apply]
 * Env: WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, UPGRADE_USER_ID + UPGRADE_RUN_ID
 *      (a REAL staff user and run: never a placeholder identity), MERGE_ORG_ID (our org, for the merge door),
 *      WORKFLOW_SERVICE_LOCAL_URL
 */
import { pathToFileURL } from "node:url";

export const DEFAULT_FEATURES = ["sales-cold-email-outreach", "feedback-request-cold-email-outreach", "pr-cold-email-outreach", "sales-crm-email-outreach"];
export const FREED_SENTENCE = "Writes each email with the template and the LLM ranked best on its leg at run time (lowest cost per outcome, narrowed by the campaign strategy).";

/** The DAG stating the pipe it serves (inert at run time): keeps two pipes' identical steps two workflows. */
export function markedForPipe(dag, pipeId) {
  return dag.forkedForPipe ? dag : { ...dag, forkedForPipe: pipeId };
}

/** The description of the freed version: the old one, plus the rule, once. */
export function freedDescription(description) {
  const d = (description ?? "").trim();
  return d.includes(FREED_SENTENCE) ? d : `${d}${d ? " " : ""}${FREED_SENTENCE}`;
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

const isGenerate = (n) => n?.type === "http.call" && n.config?.service === "content-generation" && n.config?.path === "/generate";

async function run() {
  const { withLegBestWriter, writesWithLegBest } = await import(new URL("../dist/lib/leg-best-writer.js", import.meta.url).href);
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? null : process.argv[i + 1].split(",");
  };
  const APPLY = process.argv.includes("--apply");
  const FEATURES = arg("--features") ?? DEFAULT_FEATURES;
  const ONLY = arg("--only");
  const WS = process.env.WORKFLOW_SERVICE_LOCAL_URL ?? "http://localhost:8080";
  const { WORKFLOW_SERVICE_API_KEY: WS_KEY, FEATURES_SERVICE_URL: FS, FEATURES_SERVICE_API_KEY: FS_KEY, UPGRADE_USER_ID, UPGRADE_RUN_ID, MERGE_ORG_ID } = process.env;
  if (!WS_KEY || !FS || !FS_KEY || !UPGRADE_USER_ID || !UPGRADE_RUN_ID || !MERGE_ORG_ID) {
    throw new Error("WORKFLOW_SERVICE_API_KEY, FEATURES_SERVICE_URL, FEATURES_SERVICE_API_KEY, UPGRADE_USER_ID, UPGRADE_RUN_ID and MERGE_ORG_ID are required");
  }
  const identity = (orgId) => ({ "x-org-id": orgId, "x-user-id": UPGRADE_USER_ID, "x-run-id": UPGRADE_RUN_ID });
  const report = { freed: [], merged: [], skipped: [], notFreed: [] };

  for (const featureSlug of FEATURES) {
    const listed = await call(WS, WS_KEY, "GET", `/workflows/summaries?featureSlug=${featureSlug}&status=active`, undefined, identity(MERGE_ORG_ID));
    if (listed.status !== 200) throw new Error(`summaries ${featureSlug}: ${listed.status}`);
    for (const summary of listed.body.workflows ?? listed.body) {
      const dynasty = summary.workflowDynastySlug;
      if (ONLY && !ONLY.includes(dynasty)) continue;
      const note = (reason) => {
        report.notFreed.push({ workflow: summary.workflowSlug, reason });
        console.log(`NOT FREED ${summary.workflowSlug}: ${reason}`);
      };
      try {
        const wf = (await call(WS, WS_KEY, "GET", `/workflows/${summary.id}`, undefined, identity(MERGE_ORG_ID))).body;
        if (writesWithLegBest(wf.dag)) {
          report.skipped.push(wf.workflowSlug);
          continue;
        }
        if (wf.dag.nodes.filter(isGenerate).length !== 1) {
          note("does not write with exactly one content-generation call");
          continue;
        }
        const pick = await call(FS, FS_KEY, "GET", `/internal/writer-pick?workflowSlug=${encodeURIComponent(wf.workflowSlug)}`);
        if (pick.status !== 200) {
          note(`features-service writer-pick ${pick.status}: ${JSON.stringify(pick.body).slice(0, 200)}`);
          continue;
        }
        if (!pick.body.template || !pick.body.llm) {
          note(`its leg ${pick.body.legKey} has nothing to pick: template ${pick.body.templateUnavailableReason ?? "ok"}, LLM ${pick.body.llmUnavailableReason ?? "ok"}`);
          continue;
        }
        const dag = withLegBestWriter(wf.dag);
        const line = `${wf.workflowSlug} (${pick.body.legKey}): today the leg picks ${pick.body.template.templateDynastySlug} + ${pick.body.llm.model}`;
        if (!APPLY) {
          console.log(`would free ${line}`);
          report.freed.push(line);
          continue;
        }
        const upgrade = async (d) => {
          const r = await call(WS, WS_KEY, "POST", "/workflows/upgrade", { workflowDynastySlug: dynasty, dag: d, description: freedDescription(wf.description) }, identity(wf.orgId));
          await new Promise((res) => setTimeout(res, 7000)); // createRateLimit: 10 per minute per org
          return r;
        };
        let up = await upgrade(dag);
        if (up.status === 200 || up.status === 201) {
          console.log(`freed ${line} -> ${up.body.workflow?.workflowSlug ?? "(in place)"}`);
          report.freed.push(line);
          continue;
        }
        if (up.status === 409 && up.body?.existingWorkflowId) {
          const twin = (await call(WS, WS_KEY, "GET", `/workflows/${up.body.existingWorkflowId}`, undefined, identity(MERGE_ORG_ID))).body;
          const reason = `Same workflow as ${twin.workflowDynastySlug} once neither fixes its template nor its LLM (owner 2026-10-22, BEST-TPL-LLM-1022).`;
          const m = await call(WS, WS_KEY, "POST", `/workflows/dynasty/${dynasty}/merge`, { intoWorkflowDynastySlug: twin.workflowDynastySlug, reason, decidedBy: "kevin@distribute.you" }, identity(MERGE_ORG_ID));
          if (m.status === 201) {
            console.log(`merged ${dynasty} into ${twin.workflowDynastySlug}`);
            report.merged.push(`${dynasty} -> ${twin.workflowDynastySlug}`);
          } else if (m.status === 409 && m.body?.code === "merge_across_pipes") {
            // The same steps serving ANOTHER pipe: not a twin. Its freed DAG states its own pipe (the inert one-leg mark,
            // ONE-LEG-FORKS-1020), so both live, one per pipe.
            up = await upgrade(markedForPipe(dag, pick.body.pipeId));
            if (up.status === 200 || up.status === 201) {
              console.log(`freed ${line} (marked for ${pick.body.pipeId}) -> ${up.body.workflow?.workflowSlug ?? "(in place)"}`);
              report.freed.push(line);
            } else {
              note(`same steps as ${twin.workflowDynastySlug} on another pipe, marked upgrade refused ${up.status}: ${JSON.stringify(up.body).slice(0, 300)}`);
            }
          } else {
            note(`twin of ${twin.workflowDynastySlug}, merge refused ${m.status}: ${JSON.stringify(m.body).slice(0, 300)}`);
          }
          continue;
        }
        note(`upgrade refused ${up.status}: ${JSON.stringify(up.body).slice(0, 400)}`);
      } catch (err) {
        note(`error: ${err.message}`);
      }
    }
  }
  console.log(`\nfreed ${report.freed.length}, merged ${report.merged.length}, already freed ${report.skipped.length}, not freed ${report.notFreed.length}`);
  for (const n of report.notFreed) console.log(`  NOT FREED ${n.workflow}: ${n.reason}`);
  if (report.notFreed.some((n) => /^(error|upgrade refused|twin of)/.test(n.reason))) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await run();
}
