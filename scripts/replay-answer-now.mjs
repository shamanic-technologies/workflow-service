#!/usr/bin/env node
/**
 * ANSWER-NOW-1119 before/after, offline: the lead answer's WRITER (`message_written/dy_answer_lead`, its active code =
 * before, `answerNowSource(before)` = after) re-run on real recorded cases (`writer_cases`) where the PERSON wrote last
 * and is waiting for us, at a moment outside business hours where they are. Nothing is sent and nothing is written:
 * the writer calls no door, only its model, which is called LIVE on chat-service's platform door as
 * `support: staff_experiment` with the model production used for that case, without the brand's tools (read-only
 * context; no MCP call made on a client's account). One case per (lead, reply).
 *
 * NOW: the reply + 1 minute when the reply itself came outside business hours (weekend, before 08:00 or from 18:00
 * their time), else 21:30 their time on the reply's day (the same unanswered reply, seen in the evening). The thread
 * the writer reads is the recorded one (their reply is the last message: nothing of ours after it).
 *
 * Inside the workflow-service container (reads ../dist):
 *   docker exec <container> node scripts/replay-answer-now.mjs [--limit N] [--model <provider>/<model>]
 */
import { and, eq, like } from "drizzle-orm";
import { db } from "../dist/db/index.js";
import { scripts, writerCases } from "../dist/db/schema.js";
import { runScript } from "../dist/lib/scripts/sandbox.js";
import { answerNowSource } from "../dist/lib/scripts/answer-now.js";
import { chatServicePlatformComplete } from "../dist/lib/chat-service-client.js";

const li = process.argv.indexOf("--limit");
const limit = li >= 0 ? Number(process.argv[li + 1]) : 30;
// `--model <provider>/<model>`: every case written by that model (else the one production used for the case).
const mi = process.argv.indexOf("--model");
const forced = mi >= 0 ? { provider: process.argv[mi + 1].split("/")[0], model: process.argv[mi + 1].split("/")[1], name: process.argv[mi + 1] } : null;
const support = { support: { kind: "staff_experiment", reason: "ANSWER-NOW-1119 before/after of the lead answer writer, nothing sent" } };

const writer = (await db.select().from(scripts).where(and(eq(scripts.outcome, "message_written"), eq(scripts.dynasty, "dy_answer_lead"))))
  .sort((a, b) => b.version - a.version)
  .find((s) => /sensible hour for them/.test(s.code));
if (!writer) throw new Error("no version of message_written/dy_answer_lead still holds the clock rule");
const before = writer.code;
const after = answerNowSource(before);

const rows = await db.select().from(writerCases).where(and(eq(writerCases.outcome, "message_written"), like(writerCases.recordedFrom, "message_written/dy_answer_lead/%")));

function local(at, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { weekday: p.weekday, day: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), minute: Number(p.minute), label: `${p.weekday} ${p.hour}:${p.minute}` };
}
const offHours = (l) => l.weekday === "Sat" || l.weekday === "Sun" || l.hour < 8 || l.hour >= 18;

const seen = new Set();
const cases = [];
for (const r of rows.sort((a, b) => +b.createdAt - +a.createdAt)) {
  const u = r.body?.units?.answer_requested;
  const a = u?.content;
  // Waiting for us: the newest item of their whole merged thread (every channel, events included) is a message of theirs.
  const merged = Array.isArray(a?.merged) ? a.merged.filter((x) => typeof x?.at === "string").sort((x, y) => Date.parse(x.at) - Date.parse(y.at)) : [];
  const last = merged[merged.length - 1];
  const tz = a?.lead?.timezone;
  if (!a || last?.kind !== "message" || last?.direction !== "inbound" || typeof tz !== "string") continue;
  const key = `${a.leadId}|${last.at}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const replyAt = new Date(last.at);
  const replyLocal = local(replyAt, tz);
  let now;
  if (offHours(replyLocal)) now = new Date(+replyAt + 60_000);
  else {
    now = new Date(+replyAt);
    while (!(local(now, tz).hour === 21 && local(now, tz).minute === 30)) now = new Date(+now + 60_000);
  }
  const llm = forced ?? r.body?.asked?.llm_completion?.run?.unit?.content?.llm;
  if (!llm?.provider || !llm?.model) continue;
  cases.push({ r, u, a, tz, replyLocal, now, llm });
  if (cases.length >= limit) break;
}

async function write(code, c) {
  let asked = null;
  const content = { ...c.a, now: c.now.toISOString() };
  const bridge = async (op, args) => {
    if (op === "get" && args[0] === "answer_requested") return { v: { id: "replay:answer_requested", outcome: "answer_requested", subject: c.r.body.subject ?? "", ageDays: 0, content } };
    if (op === "ask") {
      asked = args[0];
      return { v: null };
    }
    if (op === "get" && args[0] === "llm_completion") {
      const req = { ...asked.request };
      delete req.brandTools;
      delete req.strictResponseSchema;
      const answer = await chatServicePlatformComplete({ ...req, provider: c.llm.provider, model: c.llm.model }, support);
      return { v: { id: "replay:llm_completion", outcome: "llm_completion", subject: "", ageDays: 0, content: { answer, llm: c.llm } } };
    }
    return { stop: `replay: ${op} ${String(args[0])} not answered` };
  };
  const out = await runScript(code, { subject: null, brand: "replay", day: 0, tactics: c.r.body.tactics ?? {}, request: c.r.body.request ?? null }, bridge);
  if (out.kind !== "done") return { decision: out.kind, why: out.reason ?? out.message };
  const res = out.result ?? {};
  const d = res.content ?? res.answer ?? {};
  const text = String(d.message ?? d.bodyHtml ?? d.text ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return { decision: res.content ? "write" : String(d.decision ?? res.unmade ?? "?").split(":")[0], why: String(d.reason ?? res.unmade ?? ""), first: text.split(/(?<=[.!?])\s/)[0]?.slice(0, 140) ?? "" };
}

console.log(`writer v${writer.version}: ${cases.length} cases`);
const table = [];
for (const c of cases) {
  // A case whose model call fails is reported as such (a replay table, not a production path).
  const safe = (code) => write(code, c).catch((e) => ({ decision: "error", why: String(e?.message ?? e).slice(0, 200) }));
  const old = await safe(before);
  const neu = await safe(after);
  const row = { brand: c.a.brand?.name, lead: c.a.lead?.firstName, tz: c.tz, reply: c.replyLocal.label, now: local(c.now, c.tz).label, model: c.llm.model, old, neu };
  table.push(row);
  console.log(JSON.stringify(row));
}
console.log("\n| Brand | Lead local time (reply → replayed NOW) | Model | Before | Before reason | After | First line of the new message |\n|---|---|---|---|---|---|---|");
for (const t of table) {
  const cell = (s) => String(s ?? "").replace(/\|/g, "/").slice(0, 150);
  console.log(`| ${cell(t.brand)} | ${cell(`${t.reply} → ${t.now} (${t.tz})`)} | ${cell(t.model)} | ${cell(t.old.decision)} | ${cell(t.old.why)} | ${cell(t.neu.decision)} | ${cell(t.neu.first || t.neu.why)} |`);
}
process.exit(0);
