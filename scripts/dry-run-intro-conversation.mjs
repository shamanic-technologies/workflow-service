#!/usr/bin/env node
/**
 * INTRO-BOARDY-1114: the intro conversation (steps a-d) end to end on STAFF people, nothing sent.
 * Staff job, run inside the workflow-service container (sandbox + chat client from dist):
 *
 *   docker exec -i distribute-workflow-service-1 node scripts/dry-run-intro-conversation.mjs \
 *     --source /tmp/intro-answer.ts --tactics /tmp/intro-answer-tactics.json --brief /tmp/intro-brief.txt < /tmp/intro-turns.json
 *
 * stdin: `{sent, offer: {name, answers:[{question, answer}]}, turns: [{from: email, text}]}`: `sent` is what a first
 * email recorded (reader + proposed person), each turn one message a person writes. The script records the first email,
 * then answers each turn in order: every writer call is LIVE on chat-service's platform door (`support:
 * staff_experiment`), our voice is read live, the Engine's storage is kept in memory across turns, every send is
 * captured and printed, never made.
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
const brief = typeof args.brief === "string" ? readFileSync(args.brief, "utf8").trim() : "";
const input = JSON.parse(readFileSync(0, "utf8"));
const support = { support: { kind: "staff_experiment", reason: "INTRO-BOARDY-1114 dry run of the intro conversation on staff people, nothing sent" } };
const chat = (process.env.CHAT_SERVICE_URL ?? "").replace(/\/$/, "");
const voiceRes = await fetch(`${chat}/internal/skills/client-comms`, { headers: { "x-api-key": process.env.CHAT_SERVICE_API_KEY ?? "" } });
if (!voiceRes.ok) throw new Error(`voice: chat-service ${voiceRes.status}`);
const voice = (await voiceRes.json()).content;

const store = new Map();
const threads = new Map(); // email -> [{at, direction, text, messageId, subject}]
const say = (email, direction, text, subject) => {
  const l = threads.get(email) ?? [];
  l.push({ at: new Date(Date.now() + l.length * 1000).toISOString(), direction, text, subject: subject ?? "", messageId: `<${direction}-${l.length}@${email}>` });
  threads.set(email, l);
};
say(input.sent.reader.email, "outbound", input.sent.body, input.sent.subject);

async function turn(step, trigger) {
  const sends = [];
  const bridge = async (op, a) => {
    if (op === "get") return { v: { id: "dry", outcome: a[0], subject: "", ageDays: 0, content: step } };
    const key = `${a[0]}\u0000${a[1]}`;
    if (op === "storage.get") return { v: store.get(key) ?? null };
    if (op === "storage.set") return (store.set(key, a[2]), { v: null });
    if (op !== "vendor") return { stop: `no ${op}` };
    const [name, c] = a;
    if (name === "lead.followup.claim") return { v: { ok: true, data: { found: true, followup: { id: "row-" + c.body.person.email, leadId: c.body.person.leadId, email: c.body.person.email } } } };
    if (name === "lead.followup.record" || name === "lead.followup_date.set") return { v: { ok: true, data: {} } };
    if (name === "crm.person.thread") return { v: { ok: false, data: { status: 404, error: "dry run" } } };
    if (name === "instantly.conversation") return { v: { ok: true, data: { conversation: { threads: [{ campaignId: "dry" }], messages: threads.get(c.query.email) ?? [] } } } };
    if (name === "brand.profile") return { v: { ok: true, data: { brand: { name: input.offer.brand, url: input.offer.url } } } };
    if (name === "brand.offer.answers") return { v: { ok: true, data: { answers: input.offer.answers ?? [] } } };
    if (name === "brand.offer.fields") return { v: { ok: true, data: { fields: Object.fromEntries((input.offer.fields ?? []).map((x) => [x.question, { provenance: "confirmed", value: x.answer }])) } } };
    if (name === "brand.offer.economics") return { v: { ok: true, data: { name: input.offer.name, bookingUrl: null } } };
    if (name === "voice.read") return { v: { ok: true, data: { content: voice } } };
    if (name === "llm.pick") return { v: { ok: true, data: tactics.llms[c.place] } };
    if (name === "llm.complete") {
      try {
        const out = await chatServicePlatformComplete({ ...c }, support);
        return { v: { ok: true, data: { content: out.content ?? null, json: out.json ?? null } } };
      } catch (e) {
        return { v: { ok: false, data: { error: String(e).slice(0, 500) } } };
      }
    }
    if (name === "instantly.reply.send") {
      const b = c.body;
      sends.push({ kind: "reply in thread", to: b.to ?? [b.email], cc: b.cc ?? [], text: b.body_html });
      say(b.email, "outbound", b.body_html);
      return { v: { ok: true, data: { success: true } } };
    }
    if (name === "email.send") {
      const b = c.body;
      sends.push({ kind: "new email", to: [b.to], subject: b.subject, text: b.sequence[0].bodyText });
      say(b.to, "outbound", b.sequence[0].bodyText, b.subject);
      return { v: { ok: true, data: { success: true } } };
    }
    return { stop: `the dry run answers no ${name}` };
  };
  const out = await runScript(source, { subject: null, brand: "dry", day: 0, tactics, request: { now: new Date().toISOString(), brief, brandIds: ["dry-brand"], campaignId: "dry-intro", offerId: "dry-offer", ...(trigger ? { trigger } : {}) } }, bridge);
  return { out: out.kind === "done" ? out.result : out.message ?? out.reason, sends };
}

console.log(JSON.stringify({ step: "record", ...(await turn({ step: "record", sent: input.sent })) }));
for (const t of input.turns) {
  say(t.from, "inbound", t.text);
  const r = await turn({ step: "answer" }, { eventId: "evt-" + Math.random().toString(36).slice(2), person: { email: t.from } });
  console.log(JSON.stringify({ from: t.from, wrote: t.text, ...r }));
}
