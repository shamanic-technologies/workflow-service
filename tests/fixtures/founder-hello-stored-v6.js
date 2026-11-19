import type { ScriptContext, ScriptResult } from "@gtm-factory/core";
/** Founder hello (conversation): one WhatsApp hello from the founder to a person who just set up the product (MIGRATE-1105 S4). */
const BRIEF_HEADER = "";

const console = { log: (..._a: unknown[]) => {}, error: (..._a: unknown[]) => {} };
/** The sandbox ships no URL class: the one thing the steps read off a URL is its host name (throws like URL on garbage). */
const URL = function (this: { hostname: string; href: string }, u: string) {
  const m = /^[a-z][a-z0-9+.-]*:[/][/](?:[^@/?#]*@)?([^/?#:]+)(?::[0-9]+)?(?:[/?#]|$)/i.exec(String(u));
  if (!m) throw new TypeError("Invalid URL: " + String(u));
  this.hostname = m[1]!.toLowerCase();
  this.href = String(u);
} as unknown as new (u: string) => { hostname: string; href: string };
type Answer = { ok: boolean; data: Record<string, any> };
function must(ctx: any, name: string, args: Record<string, unknown>): any {
  const r: Answer = ctx.vendor.call(name, args);
  if (!r.ok) throw new Error(name + " failed (" + String(r.data.status ?? "") + "): " + String(r.data.error ?? "").slice(0, 500));
  return r.data;
}
function tolerated(ctx: any, name: string, args: Record<string, unknown>): any {
  const r: Answer = ctx.vendor.call(name, args);
  if (r.ok) return r.data;
  return { ok: false, status: r.data.status ?? null, error: r.data.body && Object.keys(r.data.body).length ? JSON.stringify(r.data.body) : String(r.data.error ?? "") };
}
/** The campaign's brief on a chat-service completion: appended to the system prompt (campaign-brief.ts, verbatim). */
function withBrief(body: Record<string, any>, brief: string): Record<string, any> {
  if (!brief) return body;
  const sys = typeof body.systemPrompt === "string" ? body.systemPrompt : "";
  const msg = typeof body.message === "string" ? body.message : "";
  if (sys.includes(brief) || msg.includes(brief)) return body;
  return { ...body, systemPrompt: (sys ? sys + "\n\n" : "") + BRIEF_HEADER + "\n" + brief };
}

function claimPersonOf(trigger) {
  const t = trigger && typeof trigger === "object" ? trigger : null;
  const str = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const p = t?.person && typeof t.person === "object" ? t.person : {};
  const person = { email: str(p.email), phone: str(p.phone), leadId: str(t?.leadId) };
  const named = !!(person.email || person.phone || person.leadId);
  // An OCCURRENCE (it carries an eventId) that names nobody must claim nobody: with no person the claim hands out the
  // queue's next due row, and that row's person was then answered with this occurrence's facts (OCCURRENCE-NAMES-NOBODY-1029).
  const occurrence = !!(t && typeof t.eventId === "string" && t.eventId.trim());
  return { person: named ? person : null, skipClaim: occurrence && !named };
}
function planClaim(claimPerson, dryRun) {
  const dry = dryRun === true || dryRun === "true";
  const named = claimPerson?.person ?? null;
  if (!dry && !named) console.log("[founder-hello] this run's trigger names nobody: nobody is claimed");
  return { dryRun: dry, skip: dry || !named };
}
function pickPerson(plan, claim, trigger, brandId) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const fold = (v) => (s(v) ? s(v).toLowerCase() : null);
  const digits = (v) => (s(v) && /^\s*(\+|00)/.test(v) ? v.replace(/^\s*(\+|00)/, "").replace(/\D/g, "") : "");
  const t = trigger && typeof trigger === "object" ? trigger : {};
  const tp = t.person && typeof t.person === "object" ? t.person : {};
  const item = t.item && typeof t.item === "object" ? t.item : {};
  const nobody = (end) => ({ go: false, skip: true, end, sendsQuery: null, timelineQuery: null, peopleQuery: null, brandId: brandId ?? null });
  let row;
  if (plan?.dryRun === true) {
    if (!s(tp.email) && !s(tp.phone)) throw new Error("pick-person: a dry run names no person (inputs.trigger.person.email or .phone)");
    row = { id: null, leadId: s(t.leadId), email: s(tp.email), phone: s(tp.phone), brandId: brandId ?? null };
  } else {
    if (plan?.skip === true) return nobody("nobody_due");
    if (claim?.found !== true) return nobody("unclaimed");
    const f = claim.followup ?? {};
    if (!f.id || (!s(f.email) && !s(f.phone))) throw new Error("pick-person: a claimed row carries no id, or neither an email nor a phone");
    const sameEmail = s(f.email) && fold(f.email) === fold(tp.email);
    const samePhone = digits(f.phone).length >= 8 && digits(f.phone) === digits(tp.phone);
    if (!sameEmail && !samePhone) {
      console.error("[founder-hello] claimed " + String(f.email ?? f.phone) + " but this run's trigger names " + String(tp.email ?? tp.phone) + ": their row is left alone");
      return nobody("other_person");
    }
    row = { id: f.id, leadId: s(f.leadId), email: s(f.email), phone: s(tp.phone) ?? s(f.phone), brandId: s(f.brandId) ?? brandId ?? null };
  }
  if (!row.brandId) throw new Error("pick-person: no brand to greet this person for");
  const email = row.email ? row.email.toLowerCase() : null;
  const phoneDigits = digits(row.phone);
  const personKey = email ? "email:" + email : phoneDigits.length >= 8 ? "phone:+" + phoneDigits : null;
  if (!personKey) throw new Error("pick-person: the person carries neither an email nor a phone");
  const firstName = s(item.firstName) ?? (s(tp.name) ? s(tp.name).split(/\s+/)[0] : null);
  return {
    go: true,
    skip: false,
    end: null,
    dryRun: plan?.dryRun === true,
    rowId: row.id,
    leadId: row.leadId,
    email,
    phone: phoneDigits.length >= 8 ? "+" + phoneDigits : null,
    brandId: row.brandId,
    firstName,
    sendsQuery: email ? { brandId: row.brandId, email } : { brandId: row.brandId, phone: "+" + phoneDigits },
    timelineQuery: { brandId: row.brandId, personKey },
    peopleQuery: { brandId: row.brandId, source: "matrix", limit: "60" },
  };
}
function admissionOf(person, sends, thread, campaignId) {
  if (person?.go !== true) return { go: false, skipTeam: true, teamBody: null, notAdmitted: null };
  const who = String(person.email ?? person.phone);
  const refuse = (code, reason) => {
    console.log("[founder-hello] " + who + " not greeted (" + code + "): " + reason);
    // A dry run (staff replay) states what a real run would decide and still writes: nothing is ever sent.
    if (person.dryRun === true) return { go: true, skipTeam: true, teamBody: null, code, notAdmitted: null, wouldNotAdmit: { reason: code + ": " + reason } };
    return { go: false, skipTeam: true, teamBody: null, code, notAdmitted: { reason: code + ": " + reason } };
  };
  if (!Array.isArray(sends?.sends)) throw new Error("admission: crm-service answered no sends list for " + who);
  const mine = sends.sends.find((x) => x?.campaignId === campaignId && ["sent", "sending"].includes(x?.status));
  if (mine) return refuse("already_greeted", "this campaign already said hello (" + String(mine.sentAt ?? mine.createdAt ?? "date unknown") + ")");
  if (!thread || !Array.isArray(thread.items)) throw new Error("admission: the person's thread did not come back");
  const failed = (thread.sources ?? []).filter((x) => x?.source === "matrix" && x?.status === "failed");
  if (failed.length) throw new Error("admission: the person's WhatsApp thread is unreadable (" + String(failed[0].error ?? "failed") + "); nobody is greeted blind");
  const chat = thread.items.find((i) => i?.kind === "message" && i?.source === "matrix");
  if (chat) return refuse("already_talking", "a WhatsApp message is already in their thread (" + String(chat.direction) + ", " + String(chat.at ?? "date unknown") + ")");
  if (person.dryRun === true) return { go: true, skipTeam: true, teamBody: null, notAdmitted: null };
  return {
    go: true,
    skipTeam: false,
    teamBody: { brandId: person.brandId, ...(person.email ? { email: person.email } : {}), ...(person.phone ? { phone: person.phone } : {}) },
    notAdmitted: null,
  };
}
function reachPlanOf(person, admission, team, replayToPhone) {
  if (admission?.go !== true) return { skip: true, notAdmitted: admission?.notAdmitted ?? null, code: admission?.code ?? null };
  if (admission.skipTeam !== true) {
    if (!team || team.notCalled === true || typeof team.staff !== "boolean" || typeof team.ownTeam !== "boolean") {
      throw new Error("reach-plan: crm-service did not say whether this person is our staff or the brand's own team; nobody is greeted blind");
    }
    const via = (Array.isArray(team.matches) ? team.matches : []).map((m) => String(m?.description ?? m?.kind)).join(", ");
    if (team.staff === true) return { skip: true, code: "staff", notAdmitted: { reason: "staff: one of our own staff (" + via + ")" } };
    if (team.ownTeam === true) return { skip: true, code: "own_team", notAdmitted: { reason: "own_team: one of the brand's own team (" + via + ")" } };
  }
  const replay = person.dryRun === true && typeof replayToPhone === "string" && replayToPhone.trim() ? replayToPhone.trim() : null;
  if (replay) return { skip: false, notAdmitted: null, code: null, reachBody: { brandId: person.brandId, fromLine: "founder", skipIfReplied: false, phone: replay } };
  return {
    skip: false,
    notAdmitted: null,
    code: null,
    reachBody: { brandId: person.brandId, fromLine: "founder", skipIfReplied: person.dryRun !== true, ...(person.email ? { email: person.email } : {}), ...(person.phone ? { phone: person.phone } : {}) },
  };
}
function reachVerdictOf(plan, check, person) {
  if (plan?.skip === true) return { ...plan, refused: null };
  if (!check || check.notCalled === true || typeof check.reachable !== "boolean") {
    throw new Error("reach-verdict: crm-service's reach check gave no answer; nothing is drafted blind");
  }
  if (check.reachable === true) return { skip: false, refused: null, persona: senderPersona(check), assistantLine: assistantLineOf(check), fromNumber: numberOf(check.fromAccount) };
  const code = typeof check.code === "string" && check.code ? check.code : "not_reachable";
  const reason = typeof check.error === "string" && check.error.trim() ? check.error : "This person cannot be reached on WhatsApp: nothing was sent.";
  console.error("[founder-hello] crm-service says WhatsApp cannot reach this person (" + code + "): nothing drafted, nothing sent");
  // A dry run (staff replay) reports the refusal and still writes, as the account that would send.
  if (person?.dryRun === true) return { skip: false, refused: null, wouldRefuse: { code, reason }, persona: senderPersona(check), assistantLine: assistantLineOf(check), fromNumber: numberOf(check.fromAccount) };
  return { skip: true, refused: { code, reason } };
}

/** The brand's assistant line (crm-service `assistantLine`): who the person can run everything through, or null. */
function assistantLineOf(check) {
  const a = check?.assistantLine;
  if (!a || typeof a.phone !== "string" || !a.phone.trim()) return null;
  const name = typeof a.persona?.name === "string" && a.persona.name.trim() ? a.persona.name.trim() : null;
  const role = typeof a.persona?.role === "string" && a.persona.role.trim() ? a.persona.role.trim() : null;
  const instructions = typeof a.persona?.instructions === "string" && a.persona.instructions.trim() ? a.persona.instructions.trim() : null;
  return { phone: a.phone.trim(), name, role, instructions };
}

function numberOf(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function senderPersona(reach) {
  const p = reach && typeof reach === "object" && reach.persona && typeof reach.persona === "object" ? reach.persona : null;
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  if (!p || !s(p.name)) return null;
  return { name: s(p.name), role: s(p.role), instructions: s(p.instructions) };
}

function personaLines(persona, brandName) {
  return [
    "WHO YOU ARE: you are " + persona.name + (persona.role ? ", " + persona.role : "") + " at " + brandName + ". You write from " + brandName + "'s WhatsApp number as yourself, " + persona.name + ": never as anyone else, never imitating how someone else at " + brandName + " writes.",
    "Present yourself exactly as your role says. If your role says you are an AI or an assistant, never say or imply you are a human, and if they ask, say plainly what you are.",
    "Messages in the thread typed by someone else at " + brandName + " are part of the history, never a model of how you write. Where a line says to write the way the owner or the founder would, write as yourself, in your own voice, keeping the relationship and its language.",
    ...(persona.instructions ? ["YOUR OWN INSTRUCTIONS (how you write and present yourself; they win over any other line about style or tone):", persona.instructions] : []),
  ];
}
function voicePlanOf(person, people, verdict) {
  const empty = { skip: true, query: null, teamBody: null };
  if (person?.go !== true || verdict?.skip !== false) return { samples: Array.from({ length: 3 }, () => empty) };
  if (!Array.isArray(people?.people)) throw new Error("voice-plan: the brand's people index answered no people list");
  const isSelf = (p) => (person.email && (p.emails ?? []).map((e) => String(e).toLowerCase()).includes(person.email))
    || (person.phone && (p.phones ?? []).map((x) => String(x).replace(/\D/g, "")).includes(person.phone.replace(/\D/g, "")));
  const samples = [];
  for (const p of people.people) {
    if (samples.length >= 3) break;
    if (!p?.personId || isSelf(p) || p.notBusiness === true || p.automated === true) continue;
    const tags = (Array.isArray(p.connectionTags) ? p.connectionTags : []).map((t) => String(t?.tag ?? ""));
    if (!tags.includes("professional_to_brand") || tags.some((t) => t.startsWith("personal"))) continue;
    const wrote = (p.presences ?? []).filter((x) => x?.source === "matrix").reduce((n, x) => n + (Number(x.outboundCount) || 0), 0);
    if (wrote < 3) continue;
    const email = (p.emails ?? []).map((e) => String(e).trim()).find(Boolean);
    const phone = (p.phones ?? []).map((x) => String(x).trim()).find(Boolean);
    if (!email && !phone) continue;
    samples.push({
      skip: false,
      query: { brandId: person.brandId, personId: p.personId },
      teamBody: { brandId: person.brandId, ...(email ? { email } : {}), ...(phone ? { phone } : {}) },
    });
  }
  while (samples.length < 3) samples.push(empty);
  return { samples };
}
function compose(person, verdict, thread, brand, rep, currentDate, v1, v2, v3, t1, t2, t3) {
  if (verdict?.skip !== false) return { skip: true, variables: null, message: null };
  const b = brand?.brand ?? {};
  const brandName = typeof b.name === "string" && b.name.trim() ? b.name.trim() : null;
  if (!brandName) throw new Error("compose: the brand read carries no name");
  const persona = senderPersona(verdict);
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const founderName = persona ? persona.name : s(rep?.salesRepFirstName);
  if (!founderName) throw new Error("compose: neither the sending account's persona nor the brand's sales rep names who says hello");
  if (!thread || !Array.isArray(thread.items)) throw new Error("compose: the person's thread did not come back");

  const recordSource = (thread.sources ?? []).find((x) => x?.source === "onboarding");
  if (recordSource?.status === "failed") {
    throw new Error("compose: crm-service could not read what " + String(person?.email ?? person?.phone) + " set up (" + String(recordSource.error ?? "failed") + "); nothing is written blind");
  }
  const records = thread.items.filter((i) => i?.source === "onboarding" && i?.event?.step === "onboarding_record" && s(i.text));
  if (!records.length) {
    throw new Error("compose: no onboarding record on " + String(person?.email ?? person?.phone) + "'s thread (crm-service); a hello that cannot name what they set up is never written");
  }
  // One record per account they opened, verbatim.
  const setup = records.flatMap((r, k) => [...(k > 0 ? [""] : []), ...String(r.text).split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim() !== "")]);

  const clip = (t, n) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "..." : x; };
  const label = (i) => {
    if (i.direction === "inbound") return "THEM";
    if (i.source === "copilot") return "US [AI Copilot]";
    if (i.sentBy === "automation" || i.source === "transactional" || i.source === "instantly") return "US [automated " + String(i.channel ?? "message") + "]";
    return "US";
  };
  const messages = thread.items.filter((i) => i?.kind === "message" && i.source !== "api" && s(i.text));
  const threadLines = messages.slice(-12).map((i) => String(i.at ?? "").slice(0, 16).replace("T", " ") + " | " + String(i.channel) + " | " + label(i) + ": " + clip(i.text, 400));

  const voice = [];
  // A sample counts only when crm-service said it is neither our staff nor the brand's own team (a test is not a client).
  const outsider = (t) => t && t.notCalled !== true && t.staff === false && t.ownTeam === false;
  // An attachment shows as its file name: never a typed line.
  const attachment = (t) => String(t).trim().length <= 80 && /\.(ogg|opus|mp3|m4a|jpe?g|png|gif|webp|pdf|mp4|mov|docx?|xlsx?)$/i.test(String(t).trim());
  for (const [v, t] of [[v1, t1], [v2, t2], [v3, t3]]) {
    if (!Array.isArray(v?.items) || !outsider(t)) continue;
    // Typed by a person of the brand (crm-service `sentBy`), never one of our automated sends.
    const outbound = v.items.filter((i) => i?.kind === "message" && i?.direction === "outbound" && i?.source === "matrix" && i?.sentBy === "person" && s(i.text) && !attachment(i.text));
    for (const i of handTyped(outbound).slice(-10)) voice.push("- " + clip(i.text, 300));
  }

  const variables = {
    founderName,
    brandName,
    writerRole: "You are " + founderName + (persona?.role ? ", " + persona.role : ", founder") + " of " + brandName + ". You write ONE WhatsApp message to one person, from " + brandName + "'s WhatsApp number, as yourself.",
    voiceRules: [
      ...(persona ? personaLines(persona, brandName) : []),
      voice.length
        ? "HOW " + founderName.toUpperCase() + " TEXTS: copy the rhythm of HIS OWN MESSAGES to " + brandName + "'s clients and leads below (how many bubbles, how long, how he opens, his punctuation and capitals), never their content."
        : "HOW " + founderName.toUpperCase() + " TEXTS: short and plain, the way a founder texts a new customer from his phone.",
    ].join("\n"),
  };
  const firstName = s(person?.firstName);
  const message = [
    "TODAY: " + String(currentDate),
    "",
    "WHO WE WRITE TO: " + (firstName ? "first name " + firstName : "first name unknown: no name in the hello"),
    "",
    "WHAT THEY SET UP WITH " + brandName.toUpperCase() + " (their own choices, the only facts you may use):",
    ...setup,
    "",
    "THIS HELLO GOES FROM: " + (verdict.fromNumber ? founderName + "'s own number, " + verdict.fromNumber : founderName + "'s own number"),
    "",
    ...(verdict.assistantLine
      ? [
          "THE ASSISTANT LINE: " + (verdict.assistantLine.name ?? "our assistant") + (verdict.assistantLine.role ? ", " + verdict.assistantLine.role : "") + ", writes to them from the assistant's OWN number " + verdict.assistantLine.phone + " (not " + founderName + "'s), right after this hello",
          ...(verdict.assistantLine.instructions ? ["THE ASSISTANT'S OWN INSTRUCTIONS (for the assistant's first message only):", verdict.assistantLine.instructions] : []),
        ]
      : ["THE ASSISTANT LINE: none"]),
    "",
    "THE MESSAGES THEY ALREADY GOT FROM US (never repeat them):",
    ...(threadLines.length ? threadLines : ["(none)"]),
    ...(voice.length ? ["", "HIS OWN MESSAGES TO " + brandName.toUpperCase() + "'S CLIENTS AND LEADS (rhythm only):", ...voice] : []),
  ].join("\n");
  return { skip: false, variables, message };
}

function handTyped(outbound) {
  const t = (i) => Date.parse(String(i?.at ?? ""));
  const sorted = [...outbound].sort((a, b) => (t(a) || 0) - (t(b) || 0));
  return sorted.filter((i, k) => {
    const at = t(i);
    if (!Number.isFinite(at)) return true;
    const near = (j) => j >= 0 && j < sorted.length && Number.isFinite(t(sorted[j])) && Math.abs(t(sorted[j]) - at) < 4 * 1000;
    return !near(k - 1) && !near(k + 1);
  });
}


function writerPlan(pick, skip) {
  if (skip === true) return { skipped: true, templateDynastySlug: null };
  const leg = pick && pick.legKey ? pick.legKey : "unknown leg";
  const templateDynastySlug = pick && pick.template ? pick.template.templateDynastySlug : null;
  if (typeof templateDynastySlug !== "string" || templateDynastySlug.length === 0) {
    throw new Error("[writer-plan] no WhatsApp template to write with on " + leg + ": " + ((pick && pick.templateUnavailableReason) || "features-service served none") + ". Nothing is written.");
  }
  console.log("[writer-plan] " + leg + (pick.strategyId ? " (strategy " + pick.strategyId + ")" : "") + ": template dynasty " + templateDynastySlug);
  return { skipped: false, templateDynastySlug, legKey: pick.legKey ?? null, strategyId: pick.strategyId ?? null };
}
function finalize(compose, draft, person, campaignId, verdict, replayToPhone, runId) {
  if (compose?.skip !== false) return { skipSend: true, written: false, sendBody: null, assistantText: null, assistantSendBody: null };
  const json = draft?.json ?? draft ?? {};
  if (json.decision !== "write") throw new Error("finalize: the writer answered " + JSON.stringify(json.decision) + "; a hello is always written now");
  const clean = (t) => String(t ?? "")
    .replace(/(\d)\s*[\u2013\u2014]\s*(?=\d)/g, "$1-")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .trim();
  // ONE writer call writes the hello, then (after the marker) the assistant's first message.
  const raw = String(json.message ?? "");
  const at = raw.indexOf("[[ASSISTANT]]");
  const text = clean(at >= 0 ? raw.slice(0, at) : raw);
  const assistantDraft = at >= 0 ? clean(raw.slice(at + 13)) || null : null;
  if (!text) throw new Error("finalize: the writer returned an empty message");
  const line = verdict?.assistantLine ?? null;
  const assistantText = line ? assistantDraft : null;
  if (line && !assistantDraft) console.error("[founder-hello] the brand has an assistant line but the writer wrote no first message for the assistant: only the hello goes out");
  if (!line && assistantDraft) console.error("[founder-hello] the writer wrote an assistant message but the brand has no assistant line: dropped");
  const who = person.leadId ?? person.email ?? person.phone;
  const idempotencyKey = "founder-hello:" + String(campaignId) + ":" + String(who);
  const assistantKey = "founder-hello-assistant:" + String(campaignId) + ":" + String(who);
  if (person.dryRun === true) {
    const replay = typeof replayToPhone === "string" && /^\+\d{8,15}$/.test(replayToPhone.trim()) ? replayToPhone.trim() : null;
    if (replayToPhone != null && !replay) throw new Error("finalize: replayToPhone must be an E.164 number, got " + JSON.stringify(replayToPhone));
    console.log("[founder-hello] DRY RUN, nothing sent to " + String(person.email ?? person.phone) + (replay ? " (replayed to " + replay + ")" : "") + ":\n" + text + (assistantText ? "\n--- from the assistant line " + line.phone + ":\n" + assistantText : ""));
    if (!replay) return { skipSend: true, written: true, dryRun: true, text, idempotencyKey, sendBody: null, assistantText, assistantSendBody: null };
    // A staff replay: the very messages, sent to the staff number only, keyed per run.
    return {
      skipSend: false,
      written: true,
      dryRun: true,
      replayTo: replay,
      text,
      idempotencyKey: "founder-hello-replay:" + String(runId),
      sendBody: { brandId: person.brandId, fromLine: "founder", ...bubbleSendFields(text), idempotencyKey: "founder-hello-replay:" + String(runId), skipIfReplied: false, phone: replay },
      assistantText,
      assistantSendBody: assistantText ? { brandId: person.brandId, fromLine: "assistant", ...bubbleSendFields(assistantText), idempotencyKey: "founder-hello-replay-assistant:" + String(runId), skipIfReplied: false, phone: replay } : null,
    };
  }
  return {
    skipSend: false,
    written: true,
    text,
    idempotencyKey,
    // Never a null field (crm-service 400s it). skipIfReplied: they wrote to the brand meanwhile = no hello.
    sendBody: { ...(person.email ? { email: person.email } : {}), brandId: person.brandId, fromLine: "founder", ...bubbleSendFields(text), idempotencyKey, skipIfReplied: true, ...(person.phone ? { phone: person.phone } : {}) },
    assistantText,
    // Right after the hello, from the assistant's own line: an answer to the hello never blocks it.
    assistantSendBody: assistantText
      ? { ...(person.email ? { email: person.email } : {}), brandId: person.brandId, fromLine: "assistant", ...bubbleSendFields(assistantText), idempotencyKey: assistantKey, skipIfReplied: false, ...(person.phone ? { phone: person.phone } : {}) }
      : null,
  };
}

function bubbleSendFields(text) {
  const all = bubblesOf(text);
  if (all.length <= 1) return { text: all[0] ?? "" };
  if (all.length <= 5) return { messages: all };
  return { messages: [...all.slice(0, 5 - 1), all.slice(5 - 1).join("\n\n")] };
}

function bubblesOf(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split(/\n[ \t]*\n/).map((b) => b.trim()).filter((b) => b !== "");
}
function assistantPlanOf(final, send) {
  if (!final?.assistantSendBody) return { skip: true, body: null };
  if (!send || send.notCalled === true || send.skipped === true) {
    console.log("[founder-hello] the hello did not go out: no first message from the assistant");
    return { skip: true, body: null };
  }
  return { skip: false, body: final.assistantSendBody };
}
function outcomeOf(person, reach, verdict, final, send, admission, assistantPlan, assistantSend) {
  const assistant = assistantState(assistantPlan, assistantSend);
  const row = (reason) => ({ skipRecord: !person?.rowId, rowId: person?.rowId ?? null, rowReason: reason });
  if (person?.go !== true) return { endKind: person?.end ?? "nobody_due", skipRecord: true, rowId: null, rowReason: null };
  if (person.dryRun === true) return { endKind: "dry_run", skipRecord: true, rowId: null, rowReason: null, text: final?.text ?? null, assistantText: final?.assistantText ?? null, assistantLine: verdict?.assistantLine ?? null, replayTo: final?.replayTo ?? null, replay: final?.replayTo ? { hello: send?.skipped === true ? { state: "refused", code: send.code ?? null } : send && send.notCalled !== true ? { state: "sent" } : { state: "none" }, assistant } : null, wouldNotAdmit: admission?.wouldNotAdmit ?? reach?.notAdmitted ?? null, refused: verdict?.wouldRefuse ?? null };
  if (reach?.notAdmitted) return { endKind: "not_admitted", notAdmitted: reach.notAdmitted, ...row("founder_hello_" + String(reach.code)) };
  // The brand stated this person is not someone of theirs (DUALIST-WA-SILENCE-1104): not admitted, a quiet skip,
  // never a refused delivery (an unsent answer).
  const notToBrand = verdict?.refused?.code === "stated_not_to_brand" || (send?.skipped === true && send?.notCalled !== true && send?.code === "stated_not_to_brand");
  if (notToBrand) return { endKind: "not_admitted", notAdmitted: { reason: "stated_not_to_brand" }, ...row("founder_hello_whatsapp_stated_not_to_brand") };
  if (verdict?.refused) return { endKind: "refused", delivery: { state: "refused", code: verdict.refused.code, reason: verdict.refused.reason }, ...row("founder_hello_whatsapp_" + verdict.refused.code) };
  if (send?.skipped === true && send?.notCalled !== true) {
    const code = typeof send.code === "string" && send.code ? send.code : "refused";
    const reason = typeof send.refusal?.error === "string" ? send.refusal.error : "WhatsApp refused the hello: nothing was sent.";
    return { endKind: "refused", delivery: { state: "refused", code, reason }, ...row("founder_hello_whatsapp_" + code) };
  }
  if (final?.written === true && send && send.notCalled !== true) return { endKind: "sent", delivery: { state: "delivered" }, assistant, ...row("founder_hello_sent") };
  throw new Error("outcome: the run reached its end with no hello sent and no reason named");
}

function assistantState(plan, send) {
  if (!plan || plan.skip === true || !send || send.notCalled === true) return { state: "none" };
  if (send.skipped === true) {
    const code = typeof send.code === "string" && send.code ? send.code : "refused";
    console.error("[founder-hello] the assistant's first message was refused (" + code + "): only the hello went out");
    return { state: "refused", code };
  }
  return { state: "sent" };
}

const FEATURE = "founder-hello";
const REFUSAL_CODES: string[] = ["whatsapp_not_linked","whatsapp_not_connected","no_phone_known","not_on_whatsapp","person_replied","automation_not_allowed","human_in_conversation","stated_not_to_brand"];
const SETTLED = {"field":"factFeed.settled","equals":false,"intervalSeconds":10,"timeoutSeconds":180,"throwWhenTimedOut":true};
const VOICE_SAMPLES = 3;
/** What an http.call step answered when its `skip` was true. */
const NOT_CALLED = { ok: false, skipped: true, notCalled: true };

/** A person-thread read waits for crm-service's settled thread (UNIBOX-FACT-LAG-1028), and a wait that ran out throws even on a tolerated read. */
function threadRead(ctx: any, query: unknown, tolerate: boolean): any {
  const args = { query, pollWhile: SETTLED };
  if (!tolerate) return must(ctx, "crm.person.thread", args);
  const r: Answer = ctx.vendor.call("crm.person.thread", args);
  if (!r.ok && r.data.status == null && String(r.data.error ?? "").includes(": still factFeed.settled = ")) throw new Error(String(r.data.error));
  if (r.ok) return r.data;
  return { ok: false, status: r.data.status ?? null, error: r.data.body && Object.keys(r.data.body).length ? JSON.stringify(r.data.body) : String(r.data.error ?? "") };
}

/** The sender's human sentence on a refusal body (http-call readRefusalReason): `details` when a sentence, else `error`. */
function refusalReason(o: any): string | null {
  if (!o || typeof o !== "object") return null;
  if (typeof o.details === "string" && o.details.trim() !== "") return o.details;
  if (o.details && typeof o.details === "object") {
    const nested = refusalReason(o.details);
    if (nested !== null) return nested;
  }
  if (typeof o.error === "string" && o.error.trim() !== "") return o.error;
  return null;
}

/** A WhatsApp send with the DAG's `skipOnRefusalCodes`: a named 4xx refusal is the http.call step's skipped answer, anything else throws. */
function sendWhatsapp(ctx: any, body: unknown): any {
  const r: Answer = ctx.vendor.call("crm.whatsapp.send", { body });
  if (r.ok) return r.data;
  const status = r.data.status;
  const code = typeof r.data.code === "string" ? r.data.code : null;
  if (typeof status === "number" && status >= 400 && status < 500 && code !== null && REFUSAL_CODES.includes(code)) {
    const raw = r.data.body && typeof r.data.body === "object" ? r.data.body : {};
    const reason = refusalReason(raw) ?? code;
    return { ok: false, skipped: true, status, code, reason, refusal: JSON.stringify(raw), delivery: { state: "refused", code, reason } };
  }
  throw new Error("crm.whatsapp.send failed (" + String(status ?? "") + "): " + String(r.data.error ?? "").slice(0, 500));
}

export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  if (typeof R.now !== "string" || !R.now) throw new Error("founder-hello: the run carries no clock (request.now)");
  const trigger = R.trigger ?? null;
  const campaignId = R.campaignId;
  const brandId = (Array.isArray(R.brandIds) && R.brandIds.length ? R.brandIds.join(",") : ctx.brand);

  const claimPerson = claimPersonOf(trigger);
  const plan = planClaim(claimPerson, false);
  const claim = plan.skip === true ? NOT_CALLED : must(ctx, "lead.followup.claim", { params: { campaignId }, body: { person: claimPerson.person } });
  const person = pickPerson(plan, claim, trigger, brandId);
  const sends = person.skip === true ? NOT_CALLED : must(ctx, "crm.whatsapp.sent", { query: person.sendsQuery });
  const thread = person.skip === true ? NOT_CALLED : threadRead(ctx, person.timelineQuery, false);
  const admission = admissionOf(person, sends, thread, campaignId);
  const team = admission.skipTeam === true ? NOT_CALLED : must(ctx, "crm.team.membership", { body: admission.teamBody });
  const reach = reachPlanOf(person, admission, team, null);
  const check = reach.skip === true ? NOT_CALLED : must(ctx, "crm.whatsapp.reach", { body: reach.reachBody });
  const verdict = reachVerdictOf(reach, check, person);

  const brand = verdict.skip === true ? NOT_CALLED : must(ctx, "brand.profile", { params: { id: person.brandId } });
  const rep = verdict.skip === true ? NOT_CALLED : must(ctx, "brand.sales_rep", { params: { brandId: person.brandId } });
  const people = verdict.skip === true ? NOT_CALLED : must(ctx, "crm.people.list", { query: person.peopleQuery });
  const voice = voicePlanOf(person, people, verdict);
  const v: any[] = [];
  const t: any[] = [];
  for (let i = 0; i < VOICE_SAMPLES; i++) {
    const s = voice.samples[i];
    v.push(s.skip === true ? NOT_CALLED : threadRead(ctx, s.query, true));
    t.push(s.skip === true ? NOT_CALLED : tolerated(ctx, "crm.team.membership", { body: s.teamBody }));
  }
  const composed = compose(person, verdict, thread, brand, rep, String(R.now).slice(0, 10), v[0], v[1], v[2], t[0], t[1], t[2]);

  const skipWrite = composed.skip === true;
  const pick = skipWrite ? NOT_CALLED : must(ctx, "template.pick", { place: "writer" });
  const writer = writerPlan(pick, skipWrite);
  const head = skipWrite ? NOT_CALLED : must(ctx, "content.template_head", { params: { slug: writer.templateDynastySlug } });
  const draft = skipWrite
    ? NOT_CALLED
    : askedWriter(ctx, "content.whatsapp", {
          featureSlug: FEATURE,
          context: composed.message,
          variables: composed.variables,
          campaignId,
          leadId: person.leadId,
          type: head.template.type,
          ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
        }, {});
  const final = finalize(composed, draft, person, campaignId, verdict, null, null);
  const send = final.skipSend === true ? NOT_CALLED : sendWhatsapp(ctx, final.sendBody);
  const assistantPlan = assistantPlanOf(final, send);
  const assistantSend = assistantPlan.skip === true ? NOT_CALLED : sendWhatsapp(ctx, assistantPlan.body);
  const outcome = outcomeOf(person, reach, verdict, final, send, admission, assistantPlan, assistantSend);
  if (outcome.skipRecord !== true) must(ctx, "lead.followup.record", { params: { id: outcome.rowId }, body: { kind: "stopped", reason: outcome.rowReason } });

  if (outcome.endKind === "sent") return { content: { end: { success: true, stopCampaign: false, delivery: outcome.delivery } } };
  if (outcome.endKind === "refused") return { unmade: String(outcome.delivery?.code ?? "") + ": " + String(outcome.delivery?.reason ?? "") };
  if (outcome.endKind === "not_admitted") return { unmade: "person_not_admitted: " + String(outcome.notAdmitted?.reason ?? "") };
  if (outcome.endKind === "nobody_due") return null;
  if (outcome.endKind === "unclaimed") throw new Error("founder-hello: the occurrence's person was made due but nobody could be claimed");
  if (outcome.endKind === "other_person") throw new Error("founder-hello: claimed someone the occurrence does not name: their row is left alone");
  throw new Error("founder-hello: the run ended " + JSON.stringify(outcome.endKind) + ", which no live run can reach");
}

/** ONE-WRITER-N-MODELS-1116-OTHERS: the template's writer request, its completion asked (the Rating picks the model), the result stored by content-generation. */
function askedWriter(ctx: any, door: string, body: Record<string, unknown>, extra: Record<string, unknown>): any {
  const r: any = must(ctx, door + ".request", { body });
  const request: Record<string, unknown> = r.request;
  if (!request || typeof request !== "object") throw new Error(door + ".request answered no request");
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("llm_completion");
  if (!done || !done.content) throw new Error("llm_completion: " + String((done && done.unmade) || "no completion") + ". Nothing is written: the run is retried later.");
  const llm: any = done.content.llm ?? {};
  const sent: Record<string, unknown> = {};
  for (const k of Object.keys(request)) if (k !== "strictResponseSchema") sent[k] = request[k];
  if (llm.provider === "anthropic" && request.strictResponseSchema) sent.responseSchema = request.strictResponseSchema;
  sent.provider = llm.provider;
  sent.model = llm.model;
  const runId = ctx.request && typeof ctx.request.runId === "string" ? ctx.request.runId : "";
  if (!runId) throw new Error(door + ": the run states no runId (the run that asked the completion)");
  return must(ctx, door + ".generate", { body: { ...body, ...extra, completion: { request: sent, answer: done.content.answer, runId } } });
}

/**
 * ONE-WRITER-N-MODELS-1116: this script names no model. Each completion it needs is ASKED of the LLM completion
 * Engine (the Rating picks the model for this script); the request is the call as written, minus the model.
 */
function askCompletion(ctx: any, call: Record<string, unknown>): { ok: true; data: Record<string, any> } {
  const request: Record<string, unknown> = {};
  for (const k of Object.keys(call)) if (k !== "provider" && k !== "model") request[k] = call[k];
  ctx.ask({ units: {}, request });
  const done: any = ctx.get("llm_completion");
  if (!done || !done.content) throw new Error("llm_completion: " + String((done && done.unmade) || "no completion") + ". Nothing is written: the run is retried later.");
  return { ok: true, data: done.content.answer };
}
function askCompletionData(ctx: any, call: Record<string, unknown>): any {
  return askCompletion(ctx, call).data;
}
/** A JSON answer, read as chat.complete read it: the parsed object, else a refusal. */
function askChatCompletion(ctx: any, call: Record<string, unknown>): { ok: boolean; data: Record<string, any> } {
  const json = askCompletion(ctx, call).data.json;
  if (!json || typeof json !== "object" || Array.isArray(json)) return { ok: false, data: { error: "chat.complete: the model answered no JSON object" } };
  return { ok: true, data: json };
}
