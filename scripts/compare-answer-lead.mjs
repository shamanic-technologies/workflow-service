#!/usr/bin/env node
/**
 * MIGRATE-1105 S1: BEFORE / AFTER of the answering script on real past runs, nothing sent, nothing booked, nothing written.
 * Staff job, run from /app/scripts inside the workflow-service container (it reads the compiled script from dist):
 *
 *   SQL=$(docker exec distribute-workflow-service-1 node scripts/record-script-cases.mjs --source windmill --flows 'ai_meeting_booking_%' --print-sql)
 *   docker exec distribute-postgres-1 psql -U postgres -At -d windmill -c "$SQL" > /tmp/<tag>-runs.json
 *   docker exec -i distribute-workflow-service-1 node scripts/compare-answer-lead.mjs --orgs <org,org> --max 10 < /tmp/<tag>-runs.json
 *
 * For each past run that WROTE to someone (BEFORE = what it sent): the script runs on what that run read (every read
 * answered from the record; a read the old run never made answers "not recorded", the public booking page is read
 * live), the writer is called LIVE through chat-service on the platform (`support: staff_experiment`), every act is
 * captured and never made (AFTER = what it would send, the decision, the booking). Prints one JSON row per run.
 */
import { readFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const { caseFromFlow } = await import("../dist/lib/scripts/windmill-cases.js");
const { runScript } = await import("../dist/lib/scripts/sandbox.js");
const { answerLeadScriptSource } = await import("../dist/lib/scripts/answer-lead-script.js");
const { productionVendorDeps } = await import("../dist/lib/scripts/vendors.js");

const ACTS = new Set(["instantly.reply.send", "instantly.reply.escalate", "email.send", "crm.whatsapp.send", "crm.meeting.book", "lead.followup_date.set", "lead.followup.record", "lead.followup.claim"]);
const SENDS = ["instantly.reply.send", "email.send", "crm.whatsapp.send"];
const orgs = typeof args.orgs === "string" ? new Set(args.orgs.split(",")) : null;
const max = Number(args.max ?? 10);
const source = answerLeadScriptSource();
const chatBase = (process.env.CHAT_SERVICE_URL ?? "").replace(/\/$/, "");
const chatKey = process.env.CHAT_SERVICE_API_KEY ?? "";
const booking = productionVendorDeps();

function sentText(call) {
  const b = call.args?.body ?? {};
  if (call.name === "instantly.reply.send") return b.body_html;
  if (call.name === "email.send") return b.sequence?.[0]?.bodyHtml ?? null;
  if (call.name === "crm.whatsapp.send") return b.text ?? (Array.isArray(b.messages) ? b.messages.join("\n\n") : null);
  return null;
}
const plain = (t) => String(t ?? "").replace(/<\/p>\s*<p>/g, "\n").replace(/<[^>]+>/g, "").trim();

const rows = JSON.parse(readFileSync(0, "utf8"));
let done = 0;
for (const r of rows) {
  if (done >= max) break;
  if (orgs && !orgs.has(String(r.args?.orgId))) continue;
  const built = caseFromFlow({ id: r.id, createdAt: r.created_at, args: r.args ?? {}, failed: r.status === "failure", error: r.error }, r.steps ?? [], { fromOutcome: "start" });
  if (!built.case) continue;
  const before = built.case.calls.filter((c) => SENDS.includes(c.name) && c.answer.ok);
  if (before.length === 0) continue;
  done++;
  const recorded = built.case.calls.slice();
  const acts = [];
  let llm = null;
  const bridge = async (op, a) => {
    if (op !== "vendor") return { stop: `no ${op} in a comparison` };
    const [name, callArgs] = a;
    if (ACTS.has(name) && name !== "lead.followup.claim") {
      acts.push({ name, args: callArgs });
      return { v: name === "crm.meeting.book" ? { ok: true, data: { status: "booked" } } : { ok: true, data: { status: "sent" } } };
    }
    if (name === "llm.complete") {
      const res = await fetch(`${chatBase}/internal/platform-complete`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": chatKey },
        body: JSON.stringify({ ...callArgs, provider: "anthropic", model: "opus", support: { kind: "staff_experiment", reason: "MIGRATE-1105 S1 before/after of the answering script" } }),
      });
      const text = await res.text();
      if (!res.ok) return { v: { ok: false, data: { error: `chat ${res.status}: ${text.slice(0, 200)}` } } };
      llm = JSON.parse(text);
      return { v: { ok: true, data: { content: llm.content ?? null, json: llm.json ?? null, model: llm.model ?? null } } };
    }
    if (name === "booking.slots") {
      try {
        return { v: { ok: true, data: await booking.readBookingSlots(callArgs.bookingUrl, callArgs.timezone) } };
      } catch (e) {
        return { v: { ok: false, data: { error: String(e) } } };
      }
    }
    if (name === "lead.followup_date.read") return { v: { ok: true, data: { owed: { kind: "owed" } } } };
    // The old run may have claimed on two queues (its own, then the previous campaign's): the one that found them.
    const i = name === "lead.followup.claim" ? Math.max(recorded.findIndex((c) => c.name === name && c.answer.data?.found === true), recorded.findIndex((c) => c.name === name)) : recorded.findIndex((c) => c.name === name);
    if (i < 0) return { v: { ok: false, data: { error: `${name} not recorded on this run` } } };
    const hit = recorded.splice(i, 1)[0];
    return { v: hit.answer };
  };
  const request = { ...built.case.request };
  const out = await runScript(source, { subject: "", brand: "", day: 0, tactics: {}, request }, bridge);
  const after = acts.filter((c) => SENDS.includes(c.name));
  console.log(
    JSON.stringify({
      run: r.id,
      at: r.created_at,
      org: r.args?.orgId,
      before: before.map((c) => ({ via: c.name, text: plain(sentText(c)) })),
      after: { outcome: out.kind === "done" ? out.result : out, sends: after.map((c) => ({ via: c.name, text: plain(sentText(c)) })), booked: acts.find((c) => c.name === "crm.meeting.book")?.args?.body?.startTime ?? null },
    }),
  );
}
