#!/usr/bin/env node
/**
 * FACTORY-P3 (b): record FRESH production cases for a ported script, straight into `script_cases` (never git: real
 * personal data). A staff job in two halves, because no service reads another's database:
 *   1. on the box host, the OWNER's database answers one read-only SELECT (printed by `--print-sql`) as JSON;
 *   2. piped into this script inside the workflow-service container, which builds gtm-factory `ReplayCase`s and
 *      stores them through the service-key route `PUT /internal/scripts/dynasty/{outcome}/{dynasty}/cases`.
 *
 *   SQL=$(docker exec distribute-workflow-service-1 node /tmp/record.mjs --outcome message_written --print-sql --days 7)
 *   docker exec distribute-postgres-1 psql -U postgres -At -d content_generation_service -c "$SQL" \
 *     | docker exec -i distribute-workflow-service-1 node /tmp/record.mjs --outcome message_written --dynasty dy_template_writer --apply
 *
 * A case states ONLY what production recorded: the inputs the work started from, every vendor call with its request
 * and answer, and what it stored. A row whose input is not recorded is EXCLUDED with its reason, never guessed.
 * Dry run by default (prints counts); `--apply` stores. Env: WORKFLOW_SERVICE_API_KEY, optional WORKFLOW_URL.
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);

/** One recorder per outcome: the owner's database, its SELECT, and how a row becomes a case. */
const RECORDERS = {
  message_written: {
    database: "content_generation_service",
    sql: (days, perTemplate) => `
SELECT coalesce(json_agg(r), '[]') FROM (
  SELECT g.id, g.created_at, g.variables_raw, g.prompt_raw, g.response_raw, g.subject, g.sequence, p.prompt AS template
  FROM (
    SELECT *, row_number() OVER (PARTITION BY prompt_type ORDER BY created_at DESC) AS n
    FROM email_generations
    WHERE created_at > now() - interval '${days} days'
  ) g
  JOIN prompts p ON p.type = g.prompt_type
  WHERE g.n <= ${perTemplate}
) r`,
    /** content-generation's own record of one generation: variables, the prompt it sent, the answer, what it stored. */
    toCase(row) {
      if (!row.variables_raw || !row.prompt_raw || !row.response_raw || !row.template || !row.subject || !Array.isArray(row.sequence)) {
        return { excluded: "a column of the generation is not recorded" };
      }
      // The campaign context block's input (the funnel's feature inputs) lives in campaign-service: not on this row.
      if (row.prompt_raw.startsWith("## Campaign Context")) return { excluded: "campaign context block (its input is not recorded with the generation)" };
      const lead = {};
      const brand = {};
      for (const [k, v] of Object.entries(row.variables_raw)) (k.startsWith("lead") ? lead : brand)[k] = v;
      return {
        case: {
          id: row.id,
          units: { lead_identified: { variables: lead }, brand_context: { variables: brand }, template_written: { text: row.template } },
          calls: [{ name: "llm.complete", args: { message: row.prompt_raw, responseSchema: "email_sequence" }, answer: { ok: true, data: row.response_raw } }],
          expect: { content: { subject: row.subject, sequence: row.sequence } },
        },
      };
    },
  },
};

/**
 * The FULL writer's cases (FACTORY-P3 a): content-generation records the exact `/complete` request per generation
 * since 2026-10-29 and serves it on `GET /internal/generations/recorded` (service key, personal data): read through
 * that route from inside this container, never from its database. Each case asserts the system prompt too.
 */
async function recordedWriterCases(from, maxCases) {
  const base = (process.env.CONTENT_GENERATION_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.CONTENT_GENERATION_SERVICE_API_KEY;
  if (!base || !key) throw new Error("CONTENT_GENERATION_SERVICE_URL and CONTENT_GENERATION_SERVICE_API_KEY are required");
  const rows = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ limit: "100", ...(from ? { from } : {}), ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${base}/internal/generations/recorded?${q}`, { headers: { "x-api-key": key } });
    const text = await res.text();
    if (!res.ok) throw new Error(`content-generation recorded generations -> ${res.status}: ${text.slice(0, 200)}`);
    const page = JSON.parse(text);
    rows.push(...page.generations);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor && rows.length < maxCases);
  return rows.slice(0, maxCases);
}

function fullWriterCase(g) {
  const i = g.inputs ?? {};
  if (!g.request || !g.response || !g.output || typeof i.promptTemplate !== "string" || typeof i.clientCommsVoice !== "string") {
    return { excluded: "a part of the generation is not recorded" };
  }
  const lead = {};
  const brand = {};
  for (const [k, v] of Object.entries(g.variables ?? {})) (k.startsWith("lead") ? lead : brand)[k] = v;
  return {
    case: {
      id: g.generationId,
      units: {
        lead_identified: { variables: lead, ...(i.language ? { language: i.language } : {}) },
        brand_context: {
          variables: brand,
          ...(i.campaignContext ? { campaignContext: i.campaignContext } : {}),
          ...(i.giveLists ? { giveLists: i.giveLists } : {}),
          ...(i.instruction ? { instruction: i.instruction } : {}),
        },
        template_written: { text: i.promptTemplate },
      },
      tactics: { llm: { provider: g.request.provider, model: g.request.model } },
      calls: [
        { name: "voice.read", answer: { ok: true, data: { content: i.clientCommsVoice, version: null } } },
        { name: "llm.complete", args: g.request, answer: { ok: true, data: g.response } },
      ],
      expect: { content: { subject: g.output.subject, sequence: g.output.sequence } },
    },
  };
}

/**
 * The reply judge's cases (FACTORY-P3 next outcomes, lead_interested): instantly-service records every judgment with
 * the exact completion body it sent and chat-service's whole answer, on either path (its own code, or the stored
 * script while switched), and serves them on `GET /internal/reply-qualifications/recorded` (service key, personal
 * data). Each case asserts the request byte for byte and the label + what it means for the reply.
 */
async function recordedJudgments(from, maxCases) {
  const base = (process.env.INSTANTLY_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.INSTANTLY_SERVICE_API_KEY;
  if (!base || !key) throw new Error("INSTANTLY_SERVICE_URL and INSTANTLY_SERVICE_API_KEY are required");
  const rows = [];
  let cursor = null;
  do {
    const q = new URLSearchParams({ limit: "200", from: from ?? new Date(Date.now() - 7 * 86_400_000).toISOString(), ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${base}/internal/reply-qualifications/recorded?${q}`, { headers: { "x-api-key": key } });
    const text = await res.text();
    if (!res.ok) throw new Error(`instantly recorded reply qualifications -> ${res.status}: ${text.slice(0, 200)}`);
    const page = JSON.parse(text);
    rows.push(...page.qualifications);
    cursor = page.hasMore ? page.nextCursor : null;
  } while (cursor && rows.length < maxCases);
  return rows.slice(0, maxCases);
}

function judgmentCase(q) {
  const i = q.inputs ?? {};
  if (typeof i.replyText !== "string") return { excluded: "the reply text is not recorded" };
  if (q.error) return { excluded: "the judgment failed (no answer to replay)" };
  if (q.request && !q.response) return { excluded: "the answer is not recorded" };
  if (q.kind && !q.classification) return { excluded: "a label production does not classify" };
  const r = q.response ?? null;
  return {
    case: {
      id: q.id,
      units: { reply_received: { text: i.replyText, subject: i.subject ?? null, ourOutreach: i.ourOutreach ?? null } },
      calls: q.request
        ? [{ name: "llm.complete", args: q.request, answer: { ok: true, data: { content: r.content ?? null, json: r.json ?? null, model: r.model ?? null, tokensInput: r.tokensInput ?? null, tokensOutput: r.tokensOutput ?? null } } }]
        : [],
      expect: q.kind ? { content: { kind: q.kind, classification: q.classification, interested: q.classification === "positive" } } : { nothing: true },
    },
  };
}

const outcome = args.outcome;
if ((args.from === "recorded" || args.source === "recorded") && outcome === "lead_interested") {
  if (!args.dynasty || args.dynasty === true) throw new Error("--dynasty is required");
  const rows = await recordedJudgments(typeof args.since === "string" ? args.since : null, Number(args.max ?? 500));
  const built = rows.map(judgmentCase);
  const cases = built.filter((b) => b.case).map((b) => b.case);
  const excluded = {};
  for (const b of built) if (b.excluded) excluded[b.excluded] = (excluded[b.excluded] ?? 0) + 1;
  const paths = {};
  for (const r of rows) paths[r.path] = (paths[r.path] ?? 0) + 1;
  console.log(`${outcome}/${args.dynasty}: ${rows.length} recorded judgments ${JSON.stringify(paths)}, ${cases.length} cases, excluded ${JSON.stringify(excluded)}${args.apply ? "" : " (dry run)"}`);
  if (args.out && args.out !== true) (await import("node:fs")).writeFileSync(args.out, JSON.stringify(cases));
  if (args.apply && cases.length > 0) await storeCases(cases, `instantly-service recorded reply judgments ${new Date().toISOString().slice(0, 10)}`);
  process.exit(0);
}
if (args.from === "recorded" || args.source === "recorded") {
  if (outcome !== "message_written") throw new Error("--source recorded serves message_written and lead_interested");
  if (!args.dynasty || args.dynasty === true) throw new Error("--dynasty is required");
  const gens = await recordedWriterCases(typeof args.since === "string" ? args.since : null, Number(args.max ?? 300));
  const built = gens.map(fullWriterCase);
  const cases = built.filter((b) => b.case).map((b) => b.case);
  const excluded = {};
  for (const b of built) if (b.excluded) excluded[b.excluded] = (excluded[b.excluded] ?? 0) + 1;
  console.log(`${outcome}/${args.dynasty}: ${gens.length} recorded generations, ${cases.length} cases, excluded ${JSON.stringify(excluded)}${args.apply ? "" : " (dry run)"}`);
  if (args.out && args.out !== true) (await import("node:fs")).writeFileSync(args.out, JSON.stringify(cases));
  if (args.apply) await storeCases(cases, `content-generation-service recorded generations ${new Date().toISOString().slice(0, 10)}`);
  process.exit(0);
}
const recorder = RECORDERS[outcome];
if (!recorder) throw new Error(`--outcome must be one of: ${Object.keys(RECORDERS).join(", ")}`);
if (args["print-sql"]) {
  process.stdout.write(recorder.sql(Number(args.days ?? 7), Number(args["per-template"] ?? 25)).trim().replace(/\s+/g, " "));
  process.exit(0);
}
if (!args.dynasty || args.dynasty === true) throw new Error("--dynasty is required");
const rows = JSON.parse(readFileSync(0, "utf8"));
const built = rows.map((r) => recorder.toCase(r));
const cases = built.filter((b) => b.case).map((b) => b.case);
const excluded = {};
for (const b of built) if (b.excluded) excluded[b.excluded] = (excluded[b.excluded] ?? 0) + 1;
const span = rows.length ? `${rows.map((r) => r.created_at).sort()[0]}..${rows.map((r) => r.created_at).sort().at(-1)}` : "none";
console.log(`${outcome}/${args.dynasty}: ${rows.length} rows (${span}), ${cases.length} cases, excluded ${JSON.stringify(excluded)}${args.apply ? "" : " (dry run)"}`);
if (!args.apply) process.exit(0);
await storeCases(cases, `${recorder.database} recorded ${new Date().toISOString().slice(0, 10)} (${span})`);

async function storeCases(cases, source) {
const key = process.env.WORKFLOW_SERVICE_API_KEY;
if (!key) throw new Error("WORKFLOW_SERVICE_API_KEY is required");
const base = (process.env.WORKFLOW_URL ?? `http://localhost:${process.env.PORT ?? 3000}`).replace(/\/$/, "");
for (let i = 0; i < cases.length; i += 8) {
  const last = i + 8 >= cases.length;
  const res = await fetch(`${base}/internal/scripts/dynasty/${outcome}/${args.dynasty}/cases${last ? "?reprove=true" : ""}`, {
    method: "PUT",
    headers: { "content-type": "application/json", "x-api-key": key },
    body: JSON.stringify({ source: source.slice(0, 200), cases: cases.slice(i, i + 8) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`cases ${i}: ${res.status} ${text.slice(0, 300)}`);
  if (last) {
    const out = JSON.parse(text);
    console.log(`  stored; the dynasty now holds ${out.total} cases; active version re-proven: ${JSON.stringify(out.reproved)}`);
  }
}
}
