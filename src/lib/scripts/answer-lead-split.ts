/**
 * ONE-WRITER-N-MODELS-1116-ANSWERER (owner 2026-11-16: « Je pensais qu'on avait qu'un script, et que le choix du model
 * est orthogonal / indépendant du script ??? », « Plutôt "Message Written" non ? »).
 *
 * The lead answerer was 7 near-identical dynasties of Message sent, one per model, each deciding, writing AND sending.
 * It becomes two scripts, built from the STORED code of `message_sent/dy_answer_lead` (the source of truth), cut at its
 * own section anchors, nothing rewritten in between:
 *
 * - `message_written/dy_answer_lead` (the WRITER): its decision and its writing (the game, the medium, the persona, the
 *   facts, the thread, the schema: the ONLY place the prompt lives). It names no model: it asks the LLM completion
 *   Engine, whose Rating picks the model for THIS writer. It calls no door. Made = the message (text, recipients,
 *   thread, channel, booking time, next date); a later / stop / escalation = no Unit, the decision handed back
 *   (`answer`). Its person-facing fields (tactic `personFields`) are what its pair proofs judge.
 * - `message_sent/dy_answer_lead` (the SENDER, an UPGRADE: no tactic `llm`): claim, rep call, state, reads, channels,
 *   then asks the writer for the message (material `answer_requested`, which only it hands), then acts: books, sends,
 *   alerts the rep, sets the lead's one next date. It calls no LLM.
 *
 * A prompt fix is ONE upgrade of the writer. The model is never named in either.
 */

export const ANSWER_WRITER_OUTCOME = "message_written";
export const ANSWER_SENDER_OUTCOME = "message_sent";
export const ANSWER_DYNASTY = "dy_answer_lead";
/** The material the sender hands its writer (everything it read); no other run holds it. */
export const ANSWER_REQUESTED = "answer_requested";
/** The fields of the writer's Unit a person reads (its pair proofs judge them). */
export const ANSWER_PERSON_FIELDS = ["message", "bookedMessage", "subject"];
export const ANSWER_WRITER_NAME = "Lead answer writer";
export const ANSWER_WRITER_DESCRIPTION =
  "Writes the one answer a lead gets: reads the thread, the facts and the open times its sender hands it, decides to write, wait, stop or hand over to the team, and writes the message with the model the Rating picks.";
export const ANSWER_SENDER_DESCRIPTION =
  "Answers one lead: claims them, reads their thread, facts and open times, asks the lead answer writer for the message, then books the time they picked, sends the message in the right thread, or alerts the sales rep, and sets their next look.";

/** The stored code's own anchors. Each must be found exactly once, else nothing is generated. */
export const ANCHORS = {
  helpersStart: "function s(v) {",
  helpersEnd: "let ctx_ = null;",
  decide: "  // 5. DECIDE once.\n",
  llmStart: "  // The writer's LLM is the Rating's pick",
  llmEnd: "  const d = draft.json || {};\n",
  decisionsStart: '  if (d.decision === "stop") {',
  writeChecksStart: "  const medium = s(d.channel);",
  writeChecksEnd: "  const recipient = email || to[0] || null;\n",
  act: "  // 6. ACT once",
  finalReturn: "  return { content: { decision: \"write\", channel: medium, booked: booked,",
  runEnd: "\n}\n\nfunction senderPersona(reach) {",
  constK: "const K = ",
};

function at(code: string, anchor: string, name: string): number {
  const first = code.indexOf(anchor);
  if (first < 0 || code.indexOf(anchor, first + 1) >= 0) throw new Error(`the stored answerer's anchor ${name} is found ${first < 0 ? 0 : "several"} times: nothing generated`);
  return first;
}

interface StoredK {
  GAME: string[];
  MEDIUM: Record<string, string[]>;
  SCHEMA: Record<string, unknown>;
  MAX_DAYS: number;
  CALL_CONSUMES: Record<string, string>;
}

/** The variables the stored decision block reads, handed by the sender as one material, read back by the writer. */
const HANDED = ["now", "brandId", "lead", "email", "phone", "brand", "economics", "fields", "answers", "voice", "bookingUrl", "booking", "slots", "merged", "open", "last", "n", "replied", "reach"];

const WRITER_HEAD = `
// Writes the one answer a lead gets (ONE-WRITER-N-MODELS-1116-ANSWERER): reads what its sender read, decides once with
// the model the Rating picks (asked from the LLM completion Engine, never named here), hands back the message or its
// decision. Calls no door: the sender acts.
export default function run(ctx) {
  const handed = ctx.get("${ANSWER_REQUESTED}");
  const a = handed.content || {};
  const req = a.request || {};
  const trigger = a.trigger || {};
${HANDED.map((k) => `  const ${k} = a.${k};`).join("\n")}
  const labels = {};
  (merged || []).forEach(function (m) { if (m && m.label) labels[m.label] = m; });
  const subject = a.leadId ? { service: "lead-service", id: a.leadId } : null;
`;

const WRITER_ASK = `  // The model is the LLM completion Engine's: the Rating picks it for this writer (askedBy), never named here.
  const schema = JSON.parse(JSON.stringify(K.SCHEMA));
  schema.properties.channel.enum = open.slice();
  schema.properties.replyTo.enum = Object.keys(labels).concat([""]);
  ctx.ask({ units: {}, ...(subject ? { subject: subject } : {}), request: { systemPrompt: system, message: message, responseFormat: "json", responseSchema: schema, brandTools: { brandId: brandId } } });
  const done = ctx.get("llm_completion");
  if (!done.content) throw new Error("no model may write for this writer: " + String(done.unmade || "none"));
  const draft = done.content.answer || {};
  const writtenWith = done.content.llm || null;
  const d = draft.json || {};
`;

const WRITER_DECISIONS = `  // A decision that sends nothing is handed back to the sender (no Unit): it sets the date, stops, or alerts the rep.
  const handBack = (answer, why) => ({ unmade: answer.decision + ": " + why + toolsNote, decided: "done", answer: Object.assign(answer, { writtenWith: writtenWith }, tools) });
  if (d.decision === "stop") return handBack({ decision: "stop", reason: String(d.reason || "their own words").slice(0, 500) }, String(d.reason || "their own words"));
  if (!nextOk) throw new Error("the writer gave no usable next date: " + JSON.stringify(nextAt));
  if (d.decision === "later") return handBack({ decision: "later", nextFollowUpAt: nextAt, nextFollowUpWhy: String(d.nextFollowUpWhy || "later").slice(0, 500) }, String(d.nextFollowUpWhy || ""));
  if (d.decision === "escalate") return handBack({ decision: "escalate", question: String(d.question || ""), nextFollowUpAt: nextAt }, String(d.question || ""));
  if (d.decision !== "write") throw new Error("the writer answered an unknown decision " + JSON.stringify(d.decision));
`;

const WRITER_RETURN = `  const text = undash(d.message);
  if (!text) throw new Error("the writer chose write with an empty message");
  return {
    content: {
      decision: "write",
      channel: medium,
      replyTo: label || "",
      to: to,
      cc: cc,
      bcc: bcc,
      message: text,
      subject: undash(d.subject),
      bookSlot: s(d.bookSlot) || "",
      bookedMessage: undash(d.bookedMessage),
      nextFollowUpAt: nextAt,
      nextFollowUpWhy: String(d.nextFollowUpWhy || "next look").slice(0, 500),
      writtenWith: writtenWith,
      ...tools,
    },
    ...(subject ? { subject: subject } : {}),
  };
}
`;

const SENDER_STEP5 = `  // 5. THE WRITER decides and writes (message_written, ONE-WRITER-N-MODELS-1116-ANSWERER): it is handed everything
  // read above and answers the message, or its decision (later, stop, escalate). This script calls no LLM.
  const leadIdOf = s(row.leadId) || named.leadId;
  ctx.ask({ units: { ${ANSWER_REQUESTED}: { content: { request: { goal: req.goal || null, brief: req.brief || null }, trigger: { item: trigger.item || {} }, leadId: leadIdOf, ${HANDED.map((k) => (k === "voice" ? "voice: { content: voice.content }" : `${k}: ${k}`)).join(", ")} } } }, ...(leadIdOf ? { subject: { service: "lead-service", id: leadIdOf } } : {}) });
  const w = ctx.get("${ANSWER_WRITER_OUTCOME}");
  const said = w.content || w.answer;
  if (!said) throw new Error("the lead answer writer answered nothing to act on: " + String(w.unmade || ""));
  const tools = typeof said.brandToolCalls === "number" ? { brandToolCalls: said.brandToolCalls } : {};
  const toolsNote = typeof said.brandToolCalls === "number" ? " (brand tool calls: " + said.brandToolCalls + ")" : "";
  const writtenWith = said.writtenWith && typeof said.writtenWith === "object" ? { writtenWith: said.writtenWith } : {};
  if (!w.content) {
    const ans = w.answer;
    if (ans.decision === "stop") {
      setDate({ stop: { reason: String(ans.reason || "their own words").slice(0, 500) } });
      close("follow_up_stopped");
      return { unmade: "stop: " + String(ans.reason || "their own words") + toolsNote, decided: "done" };
    }
    const later = s(ans.nextFollowUpAt);
    if (!later || !(Date.parse(later) > Date.parse(now)) || Date.parse(later) > Date.parse(now) + K.MAX_DAYS * 86400000) throw new Error("the writer handed back no usable next date: " + JSON.stringify(ans.nextFollowUpAt));
    if (ans.decision === "later") {
      setDate({ nextFollowupAt: later, reason: String(ans.nextFollowUpWhy || "later").slice(0, 500) });
      close("follow_up_later");
      return { unmade: "later: " + String(ans.nextFollowUpWhy || "") + toolsNote, decided: "done" };
    }
    if (ans.decision === "escalate") {
      const rep = s(brand.salesRepPhone);
      if (rep) door("crm.whatsapp.send", { body: { brandId: brandId, phone: rep, text: "A lead needs your answer: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + " (" + (email || phone) + ") asked: " + String(ans.question || "") + ". Nothing was sent to them.", idempotencyKey: sendKey + ":rep-alert" }, omitHeaders: ["x-campaign-id"] });
      setDate({ nextFollowupAt: later, reason: "Escalated to the team: " + String(ans.question || "").slice(0, 400) });
      close("follow_up_escalated");
      return { unmade: "escalate: " + String(ans.question || "") + (rep ? " (sales rep alerted)" : " (no sales rep phone)") + toolsNote, decided: "done" };
    }
    throw new Error("the writer handed back an unknown decision " + JSON.stringify(ans.decision));
  }
  const d = w.content;
  const nextAt = s(d.nextFollowUpAt);
  if (!nextAt || !(Date.parse(nextAt) > Date.parse(now)) || Date.parse(nextAt) > Date.parse(now) + K.MAX_DAYS * 86400000) throw new Error("the writer wrote with no usable next date: " + JSON.stringify(d.nextFollowUpAt));
`;

/** Split the stored answerer into its writer and its sender. Throws (nothing generated) when an anchor moved. */
export function splitAnswerLead(stored: string): { writer: string; sender: string } {
  const code = stored.replace(/\r\n/g, "\n");
  const hs = at(code, ANCHORS.helpersStart, "helpersStart");
  const he = at(code, ANCHORS.helpersEnd, "helpersEnd");
  const decide = at(code, ANCHORS.decide, "decide");
  const llmStart = at(code, ANCHORS.llmStart, "llmStart");
  const llmEnd = at(code, ANCHORS.llmEnd, "llmEnd") + ANCHORS.llmEnd.length;
  const decisions = at(code, ANCHORS.decisionsStart, "decisionsStart");
  const checks = at(code, ANCHORS.writeChecksStart, "writeChecksStart");
  const checksEnd = at(code, ANCHORS.writeChecksEnd, "writeChecksEnd");
  const act = at(code, ANCHORS.act, "act");
  const finalReturn = at(code, ANCHORS.finalReturn, "finalReturn");
  const runEnd = at(code, ANCHORS.runEnd, "runEnd");
  const kAt = at(code, ANCHORS.constK, "constK");
  if (!(hs < he && he < decide && decide < llmStart && llmStart < llmEnd && llmEnd <= decisions && decisions < checks && checks < checksEnd && checksEnd < act && act < finalReturn && finalReturn < runEnd && runEnd < kAt)) {
    throw new Error("the stored answerer's sections are not in their order: nothing generated");
  }
  const kText = code.slice(kAt + ANCHORS.constK.length).trim().replace(/;\s*$/, "");
  const K = JSON.parse(kText) as StoredK;
  for (const k of ["GAME", "MEDIUM", "SCHEMA", "MAX_DAYS", "CALL_CONSUMES"] as const) if (!(k in K)) throw new Error(`the stored answerer's K holds no ${k}: nothing generated`);

  const helpers = code.slice(hs, he);
  const prompt = code.slice(decide, llmStart); // facts, thread lines, persona, system, message: the writer's alone
  const afterDraft = code.slice(llmEnd, decisions); // tools, next date
  const writeChecks = code.slice(checks, checksEnd); // channel, recipients, thread label
  const tail = code.slice(runEnd + 4, kAt); // persona and local time helpers (prompt text): the writer's

  const writerK = { GAME: K.GAME, MEDIUM: K.MEDIUM, SCHEMA: K.SCHEMA, MAX_DAYS: K.MAX_DAYS };
  const writer = [helpers, WRITER_HEAD, prompt, WRITER_ASK, afterDraft, WRITER_DECISIONS, writeChecks, WRITER_RETURN, tail, `const K = ${JSON.stringify(writerK)};\n`].join("");

  const prefix = code.slice(0, decide);
  // The stored write path, from its checks to its last line: the sender reads the writer's Unit under the same names.
  const actBlock = code.slice(checks, finalReturn);
  const lastLine = code.slice(finalReturn, runEnd);
  const senderReturn = lastLine.replace("...addressed, ...tools } };", "...addressed, ...tools, ...writtenWith } };");
  if (senderReturn === lastLine) throw new Error("the stored answerer's last return moved: nothing generated");
  const senderK = { MAX_DAYS: K.MAX_DAYS, CALL_CONSUMES: K.CALL_CONSUMES };
  const sender = [prefix, SENDER_STEP5, actBlock, senderReturn, "\n}\n\n", `const K = ${JSON.stringify(senderK)};\n`].join("");
  return { writer, sender };
}

/** The tactics each half states. The sender names no model; the writer asks its model and states its person fields. */
export function answerTactics(storedTactics: Record<string, unknown>): { writer: Record<string, unknown>; sender: Record<string, unknown> } {
  const { llm: _llm, llms: _llms, asks, ...rest } = storedTactics;
  const senderAsks = [...new Set([...(Array.isArray(asks) ? asks.filter((x): x is string => typeof x === "string") : []), ANSWER_WRITER_OUTCOME])];
  return {
    writer: { asks: ["llm_completion"], personFields: ANSWER_PERSON_FIELDS },
    sender: { ...rest, asks: senderAsks },
  };
}

/** A case of the stored answerer (a `message_sent` writer case) as kept: what production read, the model's answer. */
export interface StoredAnswerCase {
  units: Record<string, unknown>;
  request: Record<string, unknown> | null;
  tactics: Record<string, unknown>;
  subject: string | null;
  brand: string;
  day: number;
  calls: Array<{ name: string; args: unknown; answer: { ok: boolean; data: Record<string, unknown> } }>;
  asked: Record<string, unknown>;
}

/**
 * The writer's case hidden inside a stored answerer case: the new SENDER replayed on the recorded reads (nothing called,
 * nothing sent) up to the moment it hands its writer the material, plus the model's recorded answer as the completion
 * the writer asked. Null = the case does not fit the sender (a read it makes was not recorded) or never reached the
 * model. So the writer's pairs are proven on the same real cases the answerer's copies were (PROVEN-BEFORE-PEOPLE-1116).
 */
export async function writerCaseFromStoredCase(
  senderCode: string,
  c: StoredAnswerCase,
  runScriptFn: (code: string, spec: { subject: string | null; brand: string; day: number; tactics: Record<string, unknown>; request: Record<string, unknown> | null }, bridge: (op: string, args: unknown[]) => Promise<{ v: unknown } | { stop: string }>) => Promise<unknown>,
  same: (a: unknown, b: unknown) => boolean,
): Promise<StoredAnswerCase | null> {
  const completion = c.calls.find((x) => x.name === "llm.complete");
  if (!completion || !completion.answer?.ok) return null;
  const pick = c.calls.find((x) => x.name === "llm.pick");
  const used = new Set<number>();
  let asked: Record<string, unknown> | null = null;
  let handed: Record<string, unknown> | null = null;
  const STOP = "__writer_case_captured__";
  await runScriptFn(senderCode, { subject: c.subject, brand: c.brand, day: c.day, tactics: c.tactics, request: c.request }, async (op, args) => {
    if (op === "vendor") {
      const name = String(args[0]);
      let at = c.calls.findIndex((r, i) => !used.has(i) && r.name === name && same(r.args ?? null, args[1] ?? null));
      if (at < 0) at = c.calls.findIndex((r, i) => !used.has(i) && r.name === name);
      if (at < 0) return { stop: `${name} not recorded` };
      used.add(at);
      return { v: c.calls[at]!.answer };
    }
    if (op === "storage.claim" || op === "storage.get" || op === "storage.set" || op === "storage.delete") return { v: null };
    if (op === "ask") {
      asked = (args[0] ?? null) as Record<string, unknown> | null;
      return { v: null };
    }
    if (op === "get") {
      const outcome = String(args[0]);
      if (outcome === ANSWER_WRITER_OUTCOME && asked) {
        handed = asked;
        return { stop: STOP };
      }
      if (outcome in (c.asked ?? {})) return { v: c.asked[outcome] };
      return { stop: `${outcome} not recorded` };
    }
    return { stop: String(op) };
  });
  const h = handed as { units?: Record<string, { content?: Record<string, unknown> }>; subject?: { id?: string } } | null;
  const material = h?.units?.[ANSWER_REQUESTED];
  if (!material?.content) return null;
  const llm = (pick?.answer?.ok ? pick.answer.data : null) ?? { provider: (completion.args as Record<string, unknown>)?.provider, model: (completion.args as Record<string, unknown>)?.model };
  return {
    units: { [ANSWER_REQUESTED]: { content: material.content } },
    request: null,
    tactics: {},
    subject: h?.subject?.id ?? c.subject,
    brand: c.brand,
    day: c.day,
    calls: [],
    asked: { llm_completion: { id: "recorded", outcome: "llm_completion", subject: h?.subject?.id ?? "", ageDays: 0, content: { answer: completion.answer.data, llm } } },
  };
}
