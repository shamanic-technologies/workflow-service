/**
 * MIGRATE-1105 S4b: prove the generic DAG port (`dag-port.ts`) on the old workflow's real runs, every stored version.
 *
 *   npx tsx scripts/engine-ports/prove-dag-port.ts <port> <rows.json> <dags.json> [--store-out <file>]
 *
 * `rows.json` = the Windmill SELECT of `prove-port.ts sql` (7 days of runs); `dags.json` = `{<workflowSlug>: dag}` of
 * every stored version those runs ran (workflow-service `workflows`). Each run is replayed on the port of ITS OWN
 * version's DAG, so the port itself is proven on every run of the week, then the current version's port (the one
 * stored) on the runs of that version. A run is matched on the same calls (requests included) in the same order and
 * on the SAME END for campaign-service (engine-runner.ts `endRunBodyOf`, read as campaign-service reads an end-run:
 * `delivery` matters only on a run answering an occurrence; a success with no stated delivery there is delivered; a
 * not-admitted person is idle). Real cases stay in `.context/` (gitignored), never in git.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { caseFromFlow, type RecordedFlow, type RecordedStep } from "../../src/lib/scripts/windmill-cases.js";
import { replayAll, sameJson, type ReplayCase } from "../../src/lib/scripts/replay.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { portDag } from "./dag-port.js";
import { CLIENT_WHATSAPP, FOLLOW_UP_DUE } from "./follow-up.js";

const PORTS = {
  "follow-up-due": { port: FOLLOW_UP_DUE, title: "Follow-up of a lead whose follow-up date passed", fromOutcome: "start" },
  "client-whatsapp": { port: CLIENT_WHATSAPP, title: "WhatsApp look after one current client when something happens with them", fromOutcome: "start" },
} as const;
const LEDGER_STEPS = ["pipe-of-run", "declare-consumed-lead", "declare-message-written"];

/** An old end-run body as campaign-service acts on it, in the runner's vocabulary (endFlags drops false/null). */
export function endAsCampaignReadsIt(end: Record<string, unknown>, occurrence: boolean): Record<string, unknown> {
  const e = { ...end };
  const delivery = e.delivery as { state?: unknown } | undefined;
  // A failed run that states a refusal settles as that refusal (trigger-deliveries.ts: refused first).
  if (e.success === false && delivery?.state === "refused") e.success = true;
  if (!occurrence) {
    delete e.delivery;
    // campaign-service: a not-admitted person on a successful run is an idle run (internal.ts end-run).
    if (e.personNotAdmitted) {
      delete e.personNotAdmitted;
      e.noWorkAvailable = true;
    }
    return e;
  }
  if (e.personNotAdmitted) delete e.noWorkAvailable;
  if (e.success === true && !e.delivery && !e.personNotAdmitted && e.stopCampaign !== true && e.noWorkAvailable !== true) e.delivery = { state: "delivered" };
  return e;
}

async function main() {
  const [name, rowsFile, dagsFile] = process.argv.slice(2);
  const def = PORTS[name as keyof typeof PORTS];
  if (!def || !rowsFile || !dagsFile) throw new Error(`usage: <${Object.keys(PORTS).join("|")}> <rows.json> <dags.json>`);
  const storeOut = process.argv.includes("--store-out") ? process.argv[process.argv.indexOf("--store-out") + 1] : null;
  const rows = JSON.parse(readFileSync(rowsFile, "utf8")) as Array<{ id: string; created_at: string; args: Record<string, unknown>; status: string; steps: RecordedStep[] }>;
  const dags = JSON.parse(readFileSync(dagsFile, "utf8")) as Record<string, DAG>;
  const sources = new Map<string, string>();
  const sourceOf = (slug: string) => {
    if (!sources.has(slug)) sources.set(slug, portDag(dags[slug]!, { title: def.title, runnerSteps: LEDGER_STEPS, }));
    return sources.get(slug)!;
  };
  const bySlug = new Map<string, ReplayCase[]>();
  const excluded = new Map<string, number>();
  const exclude = (why: string) => excluded.set(why, (excluded.get(why) ?? 0) + 1);
  for (const r of rows) {
    const slug = String(r.args.workflowSlug ?? "");
    if (!dags[slug]) {
      exclude(`no stored DAG for ${slug}`);
      continue;
    }
    if (r.status === "skipped") {
      exclude("gate refused the run (chassis)");
      continue;
    }
    // A call step that sent NO body where its DAG builds one: the flow Windmill held then was not the stored DAG's
    // conversion (redeployed since); that run proves nothing about this DAG.
    if ((r.steps ?? []).some((st) => (st.runnablePath ?? "").endsWith("nodes/http_call") && st.args?.skip !== true && st.args?.method === "POST" && st.args?.body == null && st.args?.service !== "campaign")) {
      exclude("a call step sent no body (the flow then held was not this DAG's conversion)");
      continue;
    }
    const steps = (r.steps ?? []).map((st) => ({ ...st, runnablePath: st.runnablePath ?? "" })).filter((st) => st.stepId !== "pipe_of_run");
    const flow: RecordedFlow = { id: r.id, createdAt: r.created_at, args: r.args ?? {}, failed: r.status !== "success", error: null };
    if (flow.failed) {
      const failedStep = [...steps].reverse().find((s) => s.status === "failure");
      flow.error = (failedStep?.result as { error?: { message?: string } } | null)?.error?.message ?? "";
    }
    const out = caseFromFlow(flow, steps, { fromOutcome: def.fromOutcome, endAsRunner: true });
    if ("excluded" in out) {
      exclude(out.excluded);
      continue;
    }
    const c = out.case;
    // The writer pick recorded under a workflow: an Engine run asks by campaign alone.
    for (const call of c.calls) {
      const q = (call.args as { query?: Record<string, unknown> } | undefined)?.query;
      if (call.name === "features.writer_pick" && q && "workflowSlug" in q) delete q.workflowSlug;
    }
    // The run's clock: the old `now` step's answer (every step read it there).
    const clock = (steps.find((st) => st.stepId === "now")?.result as { now?: unknown } | null)?.now;
    if (typeof clock === "string") c.request = { ...(c.request ?? {}), now: clock };
    if (c.expect.end) {
      const t = (c.request as { trigger?: { leadId?: unknown } } | undefined)?.trigger;
      c.expect = { end: endAsCampaignReadsIt(c.expect.end, typeof t?.leadId === "string") };
    }
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), c]);
  }
  let total = 0;
  let matched = 0;
  for (const [slug, cases] of [...bySlug].sort()) {
    const summary = await replayAll(sourceOf(slug), cases);
    total += summary.cases;
    matched += summary.matches;
    console.log(`${slug}: ${summary.matches}/${summary.cases}`);
    for (const f of summary.failures.slice(0, 5)) console.log(`  ${f.id}: ${f.diffs.slice(0, 3).join(" || ").slice(0, 700)}`);
  }
  console.log(`${name}: ${matched}/${total} runs replay; excluded ${[...excluded].map(([k, n]) => `${n} x ${k}`).join("; ") || "none"}`);
  // The port to store: the CURRENT version's (the DAG the builder makes today), proven on the runs of every version
  // whose DAG ports to the same script text.
  if (storeOut) {
    const code = def.port.build();
    // A stored version equal to today's DAG (key order aside; the retired `instruction` ref read as the brief, as the
    // converter reads it) ran exactly this script.
    const today = def.port.dag();
    const same = (slug: string) => sameJson(JSON.parse(JSON.stringify(dags[slug]).split("$ref:start-run.output.instruction").join("$ref:start-run.output.brief")), JSON.parse(JSON.stringify(today)));
    const cases = [...bySlug].filter(([slug]) => same(slug)).flatMap(([, cs]) => cs);
    console.log(`versions equal to today's DAG: ${[...bySlug.keys()].filter(same).join(", ") || "none"}`);
    const summary = await replayAll(code, cases);
    console.log(`stored port: ${summary.matches}/${summary.cases} runs of the versions it equals`);
    writeFileSync(storeOut, JSON.stringify({ outcome: def.port.outcome, dynasty: def.port.dynasty, tactics: def.port.tactics, description: def.port.description, code, cases, matches: summary.matches }));
  }
}

if (process.argv[1]?.endsWith("prove-dag-port.ts")) main().catch((e) => {
  console.error(e instanceof Error ? e.stack : e);
  process.exit(1);
});
