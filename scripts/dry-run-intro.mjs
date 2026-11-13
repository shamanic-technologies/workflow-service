#!/usr/bin/env node
/**
 * INTRO-BOARDY-1114: the intro first email on REAL prospects, nothing sent, nothing stored, nothing served.
 * Staff job, run inside the workflow-service container (it reads the sandbox and the chat client from dist):
 *
 *   docker exec -i distribute-workflow-service-1 node scripts/dry-run-intro.mjs --source /tmp/intro-first.ts \
 *     --tactics /tmp/intro-tactics.json --readers 3 --candidates 6 < /tmp/intro-prospects.json
 *
 * stdin: a JSON list of served-lead shapes `{leadId, email, data}` (lead-service's own rows). The first `--readers` are
 * the readers; the others are the people our lead search would serve as candidates. Every LLM call (research with web
 * search, match, writer) runs LIVE on chat-service's platform door as `support: staff_experiment`; our voice is read
 * live; the send is captured, never made. Prints one JSON row per reader: the email it would send and the facts it
 * stood on.
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const { runScript } = await import("../dist/lib/scripts/sandbox.js");
const { chatServicePlatformComplete } = await import("../dist/lib/chat-service-client.js");

const source = readFileSync(String(args.source), "utf8");
const tactics = JSON.parse(readFileSync(String(args.tactics), "utf8"));
const readers = Number(args.readers ?? 3);
tactics.freshCandidates = Number(args.candidates ?? 6);
const brief = typeof args.brief === "string" ? readFileSync(args.brief, "utf8").trim() : "";

const seen = new Set();
const people = JSON.parse(readFileSync(0, "utf8")).filter((p) => (seen.has(p.email) ? false : (seen.add(p.email), true)));
const support = { support: { kind: "staff_experiment", reason: "INTRO-BOARDY-1114 dry run of the intro first email on real prospects, nothing sent" } };

const chat = (process.env.CHAT_SERVICE_URL ?? "").replace(/\/$/, "");
const voiceRes = await fetch(`${chat}/internal/skills/client-comms`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
if (!voiceRes.ok) throw new Error(`voice: chat-service ${voiceRes.status}`);
const voice = (await voiceRes.json()).content;

const researched = new Map();
for (let r = 0; r < readers && r < people.length; r++) {
  const reader = people[r];
  const others = people.slice(readers);
  const queue = [reader, ...others.slice((r * 2) % Math.max(1, others.length)), ...others.slice(0, (r * 2) % Math.max(1, others.length))];
  let served = 0;
  const calls = [];
  let sent = null;
  const bridge = async (op, a) => {
    if (op === "get") return { v: { id: "dry", outcome: a[0], subject: "", ageDays: 0, content: { step: "first_email" } } };
    if (op === "storage.get") return { v: null };
    if (op === "storage.set") return { v: null };
    if (op !== "vendor") return { stop: `no ${op} in a dry run` };
    const [name, callArgs] = a;
    calls.push(name);
    if (name === "brand.profile") return { v: { ok: true, data: { brand: { name: "Distribute.you", url: "https://distribute.you" } } } };
    if (name === "lead.serve") return { v: { ok: true, data: served < queue.length ? { found: true, lead: queue[served++] } : { found: false, reason: "audience_exhausted" } } };
    if (name === "crm.person.thread") return { v: { ok: false, data: { status: 404, error: "dry run: not read" } } };
    if (name === "scraping.page") return { v: { ok: false, data: { status: 0, error: "dry run: the site is read by the research web search" } } };
    if (name === "llm.pick") return { v: { ok: true, data: tactics.llms[callArgs.place] } };
    if (name === "voice.read") return { v: { ok: true, data: { content: voice } } };
    if (name === "email.send") {
      sent = callArgs.body;
      return { v: { ok: true, data: { success: true } } };
    }
    if (name === "llm.complete") {
      const key = callArgs.webSearch ? callArgs.message : null;
      if (key && researched.has(key)) return { v: researched.get(key) };
      try {
        const out = await chatServicePlatformComplete({ ...callArgs }, support);
        const v = { ok: true, data: { content: out.content ?? null, json: out.json ?? null, model: out.model ?? null } };
        if (key) researched.set(key, v);
        return { v };
      } catch (e) {
        return { v: { ok: false, data: { error: String(e).slice(0, 500) } } };
      }
    }
    return { stop: `the dry run answers no ${name}` };
  };
  const out = await runScript(source, { subject: null, brand: "dry", day: 0, tactics, request: { now: new Date().toISOString(), brief, brandIds: ["f4d73dab-1f9d-49b2-b16e-63ecde76a5eb"], campaignId: "dry-run", dryRun: false } }, bridge);
  console.log(JSON.stringify({ reader: reader.email, outcome: out.kind, result: out.kind === "done" ? out.result : out.message ?? out.reason, wouldSend: sent ? { to: sent.to, subject: sent.subject, body: sent.sequence?.[0]?.bodyText, signature: sent.signature } : null, calls }));
}
