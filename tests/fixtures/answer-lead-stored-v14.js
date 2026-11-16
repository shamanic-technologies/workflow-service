
// Answers ONE lead per run (MIGRATE-1105 S1). Reads: the claim, the lead's state, the thread, the brand's facts,
// the open times. Decides once (one model call). Acts once: a reply, a booking + its confirmation, a hand-over, or
// nothing; always leaves the lead's ONE next date. The clock is ctx.request.now (the run's start), never Date.now().
function door(name, args) {
  return ctx_.vendor.call(name, args);
}
function must(name, args) {
  const a = door(name, args);
  if (!a.ok) throw new Error(name + " failed: " + String(a.data && a.data.error));
  return a.data;
}
function s(v) {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}
function addr(v) {
  const t = typeof v === "string" ? v : v && typeof v === "object" ? String(v.email || v.address || "") : "";
  const m = t.match(/<([^<>]+)>/);
  const a = (m ? m[1] : t).trim().toLowerCase();
  return /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/.test(a) ? a : null;
}
function addrs(v) {
  const l = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  return l.map(addr).filter(Boolean);
}
function uniq(l) {
  return l.filter(function (x, i) { return l.indexOf(x) === i; });
}
function undash(t) {
  return String(t || "").replace(/(\d)\s*[–—]\s*(?=\d)/g, "$1-").replace(/\s*[–—]\s*/g, ", ").trim();
}
let ctx_ = null;

export default function run(ctx) {
  ctx_ = ctx;
  const req = ctx.request || {};
  let trigger = req.trigger && typeof req.trigger === "object" ? req.trigger : null;
  const now = s(req.now);
  if (!now) throw new Error("the run states no clock (request.now)");
  const brandId = s(req.brandId) || (Array.isArray(req.brandIds) ? s(req.brandIds[0]) : null);
  const campaignId = s(req.campaignId);
  const offerId = s(req.offerId);
  // The WhatsApp line the campaign states it writes from (CAMPAIGN-WA-LINE-1028); none = crm-service picks.
  const line = s(req.whatsappSenderPhone);
  if (!brandId || !campaignId) throw new Error("the run names no brand or campaign");
  // A proactive tick (no occurrence): the next lead the brand already holds whose one follow-up date passed, served to
  // this campaign only (never a fresh lead) and held for its claim below (SCRIPT-VALUE-RATING-1113-WF1).
  if (!trigger) {
    const served = door("lead.serve", { dueFollowupOnly: true });
    if (!served.ok) throw new Error("lead.serve failed: " + String(served.data && served.data.error));
    if (!served.data.found || !served.data.lead) return { unmade: "nobody_due: " + String(served.data.reason || "none"), decided: "idle" };
    const ld = served.data.lead;
    trigger = { leadId: s(ld.leadId), person: { email: s(ld.email), phone: s(ld.phone) }, sourceTriggerId: "follow_up_due", item: { kind: "follow_up_due", note: "their follow-up date passed: nothing new happened, this is our next look" } };
  }
  const p = trigger.person || {};
  const named = { email: s(p.email) ? s(p.email).toLowerCase() : null, phone: s(p.phone), leadId: s(trigger.leadId) };
  const relationships = s(ctx.tactics.relationships) || "pure_prospect";

  // 1. WHO: the person the occurrence names, claimed on this campaign (lead-service judges who may be answered).
  const claim = must("lead.followup.claim", { params: { campaignId: campaignId }, body: { person: named, relationships: relationships } });
  if (!claim.found) {
    const refused = ((claim.relationships && claim.relationships.refused) || [])[0];
    // Nobody owed on this campaign (or their relationship is not judged yet) is this script's reading, never a refusal:
    // nothing to do now (MON-UNSENT-RED-1111).
    if (refused) return { unmade: "person_not_admitted: " + String(refused.reason || refused.code || "refused") };
    return { unmade: "nobody_due: " + String(claim.reason || ""), decided: "idle" };
  }
  const row = claim.followup;
  // ONE campaign converses with a lead (SCRIPT-VALUE-RATING-1113-WF1): several campaigns of the brand may answer the same
  // lead (a Meeting booked path and the Lead event answer; one reply raises several events). The campaign holding the
  // lead's claim answers; another one within 30 minutes of its last answer sends nothing.
  const answerKey = s(row.leadId) || named.leadId || named.email || named.phone;
  if (answerKey) {
    const owner = ctx.storage.claim("answering_leads", String(answerKey), { campaignId: campaignId, at: now });
    if (owner && owner.campaignId !== campaignId && (Date.parse(now) - Date.parse(String(owner.at)) < 30 * 60000 || (owner.holdUntil && Date.parse(String(owner.holdUntil)) > Date.parse(now)))) {
      must("lead.followup.record", { params: { id: row.id }, body: { kind: "stopped", reason: "answered_by_another_campaign" } });
      return { unmade: "answered_elsewhere: campaign " + String(owner.campaignId) + " answers this lead", decided: "done" };
    }
    if (!owner || owner.campaignId !== campaignId || owner.at !== now) ctx.storage.set("answering_leads", String(answerKey), { campaignId: campaignId, at: now });
  }

  // 1b. THE REP CALL (ported from the AI Instant Call workflow, MIGRATE-1105 S1b): a positive reply or a form fill rings
  // the brand's sales rep the moment it lands, as the Reply Callback / Form Callback campaigns did, before any answer.
  // The call is the Booking call Engine's Unit, asked as a child run (picked by the Rating among the scripts this
  // campaign's strategy keeps; none = "no_script", no call). The person's row stays this run's: handed as claimed, the
  // call script claims and stops nothing. Whatever it answers, this run goes on to answer the person.
  const occurrence = K.CALL_CONSUMES[String(trigger.sourceTriggerId || trigger.triggerId || "")];
  if (occurrence) {
    const leadId = s(row.leadId) || named.leadId;
    const handed = {};
    handed[occurrence] = { content: trigger, ...(leadId ? { subject: { service: "lead-service", id: leadId } } : {}) };
    ctx.ask({ units: handed, request: Object.assign({}, req, { claimed: claim }) });
    ctx.get("booking_call");
  }
  const email = s(row.email) ? s(row.email).toLowerCase() : named.email;
  const phone = s(row.phone) || named.phone;
  const sendKey = s(trigger.eventId) ? "answer-lead:event:" + trigger.eventId : "answer-lead:" + row.id + ":" + String(row.dueAt);
  const close = (reason) => must("lead.followup.record", { params: { id: row.id }, body: { kind: "stopped", reason: reason } });
  const setDate = (body) => must("lead.followup_date.set", { params: { id: row.id }, query: { brandId: brandId }, body: body });

  // 2. STATE: only their own stops end it; a lead event is answered whatever engaged them.
  const state = must("lead.followup_date.read", { params: { id: row.id }, query: { brandId: brandId } });
  const owed = state.owed || {};
  const stops = (Array.isArray(owed.reasons) ? owed.reasons : []).filter(function (r) {
    return ["positive_reply", "meeting_booked", "meeting_attended", "in_conversation", "sequence_running", "relationship_not_judged", "same_person_question_open", "identity_unresolved"].indexOf(r) < 0;
  });
  if (owed.kind === "stop" && (stops.length > 0 || !Array.isArray(owed.reasons) || owed.reasons.length === 0)) {
    close("follow_up_stopped");
    return { unmade: "stopped: " + String(owed.reason || stops[0] || "stop"), decided: "done" };
  }

  // 3. READ everything the writer needs.
  const lead = (must("lead.detail", { params: { id: row.id }, query: { campaignId: campaignId } }).leadDetail || {}).lead || {};
  const personKey = email ? "email:" + email : "phone:+" + String(phone || "").replace(/\D/g, "");
  // A person crm-service holds no thread for (404) has none yet; any other failure stops the run (never written blind).
  const threadRead = door("crm.person.thread", { query: { brandId: brandId, personKey: personKey }, pollWhile: { field: "factFeed.settled", equals: false, intervalSeconds: 10, timeoutSeconds: 180, throwWhenTimedOut: true } });
  if (!threadRead.ok && threadRead.data.status !== 404) throw new Error("crm.person.thread failed: " + String(threadRead.data.error));
  const items = threadRead.ok && Array.isArray(threadRead.data.items) ? threadRead.data.items : [];
  const conversation = email ? door("instantly.conversation", { query: { email: email } }) : { ok: false, data: {} };
  const convo = conversation.ok && conversation.data.conversation && typeof conversation.data.conversation === "object" ? conversation.data.conversation : {};
  const threads = Array.isArray(convo.threads) ? convo.threads : [];
  const brand = (must("brand.profile", { params: { id: brandId } }).brand) || {};
  const economics = offerId ? must("brand.offer.economics", { params: { offerId: offerId } }) : {};
  const answers = offerId ? must("brand.offer.answers", { params: { brandId: brandId, offerId: offerId } }) : {};
  const fields = offerId ? must("brand.offer.fields", { params: { brandId: brandId, offerId: offerId } }) : must("brand.fields", { params: { brandId: brandId } });
  const voice = must("voice.read", {});
  const bookingUrl = s(economics.bookingUrl);
  const booking = bookingUrl ? must("booking.slots", { bookingUrl: bookingUrl, timezone: s(lead.timezone) || "UTC" }) : { slots: [] };
  const slots = Array.isArray(booking.slots) ? booking.slots : [];

  // 3b. THE THREAD = the person's Unibox (every channel) + every email of their conversations, each with who wrote it,
  // who was on it and its Message-ID (EVERY-PERSON-ON-THE-THREAD-1109): a colleague who answered in their thread is
  // in it as himself. An email held by both reads is shown once (the one carrying the Message-ID and everyone on it).
  const mails = (Array.isArray(convo.messages) ? convo.messages : []).map(function (m) {
    const parts = Array.isArray(m.participants) ? m.participants : [];
    const role = function (r) { return parts.filter(function (x) { return x && x.role === r; }).map(function (x) { return addr(x.email); }).filter(Boolean); };
    return { at: String(m.at || ""), kind: "message", direction: m.direction, channel: "email", source: "email", subject: m.subject, text: m.text, messageId: s(m.messageId),
      from: parts.length > 0 ? role("from") : addrs(m.from), to: parts.length > 0 ? role("to") : addrs(m.to), cc: role("cc"), bcc: role("bcc") };
  });
  const mailKeys = {};
  mails.forEach(function (m) { if (m.messageId) mailKeys["id:" + m.messageId] = true; mailKeys["t:" + m.direction + ":" + m.at.slice(0, 16)] = true; });
  const unibox = items.filter(function (m) {
    if (m.channel !== "email" || m.kind !== "message") return true;
    const id = s(m.ref && m.ref.messageId) || s(m.messageId);
    return !(id && mailKeys["id:" + id]) && !mailKeys["t:" + m.direction + ":" + String(m.at || "").slice(0, 16)];
  }).map(function (m) {
    if (m.channel !== "email" || m.kind !== "message") return m;
    return Object.assign({}, m, { messageId: s(m.ref && m.ref.messageId) || s(m.messageId), from: addrs(m.from), to: addrs(m.to), cc: addrs(m.cc), bcc: [] });
  });
  const merged = unibox.concat(mails).sort(function (a, b) { return String(a.at || "").localeCompare(String(b.at || "")); });
  // Every email we can answer in its thread gets a label the writer names (replyTo).
  const labels = {};
  let n = 0;
  merged.forEach(function (m) { if (m.channel === "email" && m.kind === "message" && m.messageId) { n++; m.label = "M" + n; labels[m.label] = m; } });

  // 4. WHERE: the channels open to this person; the writer picks one, and on email who it goes to and in which thread.
  const inbound = merged.filter(function (m) { return m.kind === "message" && m.direction === "inbound"; });
  const last = inbound.length > 0 ? inbound[inbound.length - 1] : null;
  const open = [];
  if (email || n > 0) open.push("email");
  let reach = null;
  if (phone || (last && last.channel === "whatsapp")) {
    const r = door("crm.whatsapp.reach", { body: { brandId: brandId, ...(email ? { email: email } : {}), ...(phone ? { phone: phone } : {}), ...(line ? { fromAccount: line } : {}) } });
    if (r.ok && r.data.reachable === true) {
      reach = r.data;
      open.push("whatsapp");
    }
  }
  const replied = threads.filter(function (t) { return t.replied === true && s(t.campaignId); }).sort(function (a, b) { return String(b.lastInboundAt || "").localeCompare(String(a.lastInboundAt || "")); })[0] || null;
  if (open.length === 0) {
    setDate({ nextFollowupAt: new Date(Date.parse(now) + 30 * 86400000).toISOString(), reason: "No way to write to them yet" });
    close("follow_up_no_channel");
    return { unmade: "no_channel" };
  }

  // 5. DECIDE once.
  const factLines = [];
  const f = fields.fields || {};
  Object.keys(f).forEach(function (k) {
    const v = f[k];
    if (v && v.provenance === "confirmed" && v.value !== null && v.value !== undefined) factLines.push("- " + k + ": " + (typeof v.value === "string" ? v.value : JSON.stringify(v.value)));
  });
  (Array.isArray(answers.answers) ? answers.answers : []).forEach(function (a) {
    const text = String(a.answer || "");
    factLines.push("- " + a.question + " " + (/^\s*PLACEHOLDER/.test(text) ? "(not answered by our client yet)" : text));
  });
  const threadLines = merged.slice(-40).map(function (m) {
    const who = m.kind !== "message" ? "EVENT" : m.direction === "outbound" ? "US" : "THEM";
    const text = String(m.text || (m.event && m.event.text) || m.subject || "").slice(0, 2000);
    const head = m.label
      ? " label " + m.label + ", from " + (m.from.join(", ") || "?") + " to " + (m.to.join(", ") || "?") + (m.cc.length > 0 ? " cc " + m.cc.join(", ") : "") + (m.bcc.length > 0 ? " bcc " + m.bcc.join(", ") : "") + (s(m.subject) ? ", subject: " + m.subject : "")
      : "";
    return "[" + String(m.at) + "] " + who + " (" + String(m.channel || m.source || "") + ")" + head + ": " + text;
  });
  // On WhatsApp the writer IS the sending line's persona (crm-service states it on the reach answer); none = as before.
  const persona = reach ? senderPersona(reach) : null;
  const both = open.length > 1;
  const mediumLines = [].concat.apply([], open.map(function (c) { return (both ? ["ON " + c.toUpperCase() + ":"] : []).concat(K.MEDIUM[c]); }));
  const personaBlock = persona ? (both ? ["WHEN YOU WRITE ON WHATSAPP:"] : []).concat(personaLines(persona, String(brand.name || ""))) : [];
  const system = [voice.content].concat(personaBlock, K.GAME, [s(req.goal) ? "WHAT THIS ANSWER WORKS TOWARD (the campaign's Target):\n" + req.goal : ""], mediumLines, [s(req.brief) ? "THE CAMPAIGN'S BRIEF (from the client):\n" + req.brief : ""]).filter(Boolean).join("\n\n");
  const message = [
    "THEIR LOCAL TIME:\n" + localTimeLines(now, { timezone: lead.timezone, city: lead.city, country: lead.country, phone: phone, places: s(lead.state) ? [{ label: "their state or region", value: lead.state }] : [] }).join("\n"),
    "THE PERSON: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + (s(lead.headline) ? ", " + lead.headline : "") + (email ? ", " + email : ""),
    "THE BRAND: " + String(brand.name || "") + (s(economics.name) ? ". What we sell: " + economics.name : ""),
    "THE FACTS:\n" + (factLines.join("\n") || "(none stated)"),
    "BOOKING LINK: " + (bookingUrl || "none"),
    "OPEN TIMES (" + String(booking.timezone || "UTC") + "):\n" + (slots.length > 0 ? slots.join("\n") : "(none read)"),
    "WHAT JUST HAPPENED: " + JSON.stringify(trigger.item || {}).slice(0, 1500),
    "THE CHANNELS OPEN: " + open.join(", ") + (last ? " (their last message came on " + String(last.channel || last.source || "") + ")" : "") + (open.indexOf("email") >= 0 && n === 0 ? ". Email: " + (replied ? "a reply in the thread they answered" : "a follow-up in their last email thread") : ""),
    "THE THREAD (oldest first):\n" + (threadLines.join("\n") || "(empty)"),
  ].join("\n\n");
  // The writer's LLM is the Rating's pick for this Engine and this call (LLM-PICK-SCRIPTS-1112): never one the script
  // states, never a default; none = the run fails, nothing written.
  const llm = must("llm.pick", { place: "writer" });
  if (!s(llm.provider) || !s(llm.model)) throw new Error("llm.pick answered no LLM for the writer: nothing is written");
  // The brand's own tools on every call (BRAND-MCP-1109): the writer looks up what this person already has with the
  // brand, and acts when the brand's team asks, before it decides. No server plugged = today's one-shot call.
  // The schema names this run's own choices: the channels open to them and the labels of the emails they can be
  // answered in (empty = a new thread), so the writer picks among what exists.
  const schema = JSON.parse(JSON.stringify(K.SCHEMA));
  schema.properties.channel.enum = open.slice();
  schema.properties.replyTo.enum = Object.keys(labels).concat([""]);
  const draft = must("llm.complete", { provider: llm.provider, model: llm.model, systemPrompt: system, message: message, responseFormat: "json", responseSchema: schema, brandTools: { brandId: brandId } });
  const d = draft.json || {};
  // What the writer looked up or did through the brand's tools, on the run's output (each call is an event on the
  // completion's run); absent when the brand plugged no server, so those outputs are unchanged.
  const tools = typeof draft.brandToolCalls === "number" ? { brandToolCalls: draft.brandToolCalls } : {};
  const toolsNote = typeof draft.brandToolCalls === "number" ? " (brand tool calls: " + draft.brandToolCalls + ")" : "";
  const nextAt = s(d.nextFollowUpAt);
  const nextOk = nextAt && Date.parse(nextAt) > Date.parse(now) && Date.parse(nextAt) <= Date.parse(now) + K.MAX_DAYS * 86400000;

  if (d.decision === "stop") {
    setDate({ stop: { reason: String(d.reason || "their own words").slice(0, 500) } });
    close("follow_up_stopped");
    return { unmade: "stop: " + String(d.reason || "their own words") + toolsNote, decided: "done" };
  }
  if (!nextOk) throw new Error("the writer gave no usable next date: " + JSON.stringify(nextAt));
  if (d.decision === "later") {
    setDate({ nextFollowupAt: nextAt, reason: String(d.nextFollowUpWhy || "later").slice(0, 500) });
    close("follow_up_later");
    return { unmade: "later: " + String(d.nextFollowUpWhy || "") + toolsNote, decided: "done" };
  }
  if (d.decision === "escalate") {
    const rep = s(brand.salesRepPhone);
    if (rep) door("crm.whatsapp.send", { body: { brandId: brandId, phone: rep, text: "A lead needs your answer: " + [lead.firstName, lead.lastName].filter(Boolean).join(" ") + " (" + (email || phone) + ") asked: " + String(d.question || "") + ". Nothing was sent to them.", idempotencyKey: sendKey + ":rep-alert" }, omitHeaders: ["x-campaign-id"] });
    setDate({ nextFollowupAt: nextAt, reason: "Escalated to the team: " + String(d.question || "").slice(0, 400) });
    close("follow_up_escalated");
    return { unmade: "escalate: " + String(d.question || "") + (rep ? " (sales rep alerted)" : " (no sales rep phone)") + toolsNote, decided: "done" };
  }
  if (d.decision !== "write") throw new Error("the writer answered an unknown decision " + JSON.stringify(d.decision));
  const medium = s(d.channel);
  if (!medium || open.indexOf(medium) < 0) throw new Error("the writer chose a channel that is not open: " + JSON.stringify(d.channel) + " (open: " + open.join(", ") + ")");
  // Who it goes to, as the writer chose (email). Addresses are cleaned (trimmed, lowercased, deduped), never added.
  const to = uniq(addrs(d.to));
  // The address it goes to is never also copied: the writer's own To, else the person (the sender's default To).
  const sentTo = to.length > 0 ? to : email ? [email] : [];
  const cc = uniq(addrs(d.cc)).filter(function (a) { return sentTo.indexOf(a) < 0; });
  const bcc = uniq(addrs(d.bcc)).filter(function (a) { return sentTo.indexOf(a) < 0 && cc.indexOf(a) < 0; });
  const chosen = { ...(to.length > 0 ? { to: to } : {}), ...(cc.length > 0 ? { cc: cc } : {}), ...(bcc.length > 0 ? { bcc: bcc } : {}) };
  const label = medium === "email" ? s(d.replyTo) : null;
  const target = label ? labels[label] : null;
  if (label && !target) throw new Error("the writer answers an email that is not in the thread: " + JSON.stringify(label));
  const recipient = email || to[0] || null;

  // 6. ACT once: book first when they picked an open time, then the one message.
  let text = undash(d.message);
  let booked = null;
  const pick = s(d.bookSlot);
  if (pick && slots.indexOf(pick) >= 0 && s(d.bookedMessage) && email) {
    const b = door("crm.meeting.book", { body: { brandId: brandId, idempotencyKey: sendKey + ":book", ...(bookingUrl ? { bookingPageUrl: bookingUrl } : {}), ...(s(booking.calendarId) ? { calendarId: booking.calendarId } : {}), startTime: pick, person: { email: email, ...(s(lead.firstName) ? { firstName: lead.firstName } : {}), ...(s(lead.lastName) ? { lastName: lead.lastName } : {}), ...(phone ? { phone: phone } : {}) } } });
    if (b.ok && b.data.status === "booked") {
      booked = pick;
      text = undash(d.bookedMessage);
    } else if (!b.ok && b.data.status !== 422) throw new Error("crm.meeting.book did not settle: " + String(b.data.error));
  }
  if (!text) throw new Error("the writer chose write with an empty message");
  let sent;
  if (medium === "whatsapp") {
    const bubbles = text.split(/\n\s*\n/).map(function (t) { return t.trim(); }).filter(Boolean);
    sent = door("crm.whatsapp.send", { body: { brandId: brandId, ...(email ? { email: email } : {}), ...(phone ? { phone: phone } : {}), ...(bubbles.length > 1 ? { messages: bubbles } : { text: text }), ...(line ? { fromAccount: line } : {}), idempotencyKey: sendKey } });
  } else if (!recipient) {
    throw new Error("the writer chose email with no address to write to");
  } else if (target) {
    // In the thread of the email they answer, whoever wrote it: the mailbox holding it sends (instantly-service).
    sent = door("instantly.reply.send", { body: { email: recipient, body_html: text, sent_by: "automation", in_reply_to: target.messageId, ...chosen } });
  } else if (n > 0 && threads.length > 0 && s(threads[0].campaignId)) {
    // A new thread, from the mailbox of their conversation.
    sent = door("instantly.reply.send", { body: { campaign_id: threads[0].campaignId, email: recipient, body_html: text, sent_by: "automation", new_thread_subject: undash(d.subject) || String(brand.name || ""), ...chosen } });
  } else if (n === 0 && replied) {
    sent = door("instantly.reply.send", { body: { campaign_id: replied.campaignId, email: recipient, body_html: text, sent_by: "automation" } });
  } else {
    sent = door("email.send", { body: { type: "broadcast", tag: "follow-up", followUp: true, to: recipient, subject: undash(d.subject) || String(brand.name || ""), sequence: [{ step: 1, bodyHtml: text, daysSinceLastStep: 0 }], idempotencyKey: sendKey, leadId: s(lead.leadId) || named.leadId, campaignId: campaignId } });
  }
  if (!sent.ok) {
    // A named refusal about the person is an outcome (nothing sent, the date kept); anything else fails the run.
    if (s(sent.data.code) && sent.data.status >= 400 && sent.data.status < 500) {
      setDate({ nextFollowupAt: nextAt, reason: "Not sent: " + sent.data.code });
      close("follow_up_refused");
      return { unmade: "refused: " + sent.data.code + toolsNote };
    }
    throw new Error("the send failed: " + String(sent.data.error));
  }
  setDate({ nextFollowupAt: nextAt, reason: String(d.nextFollowUpWhy || "next look").slice(0, 500), sent: { channel: medium } });
  close(booked ? "booking_confirmed" : "follow_up_sent");
  const addressed = medium === "email" && (to.length > 0 || cc.length > 0 || bcc.length > 0) ? { recipients: { to: to, cc: cc, bcc: bcc } } : {};
  return { content: { decision: "write", channel: medium, booked: booked, inThread: medium === "email" ? (n > 0 ? Boolean(target) : Boolean(replied)) : null, ...(target ? { replyTo: target.messageId } : {}), ...addressed, ...tools } };
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
function localTimeLines(nowIso, clues) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const city = [s(clues?.city), s(clues?.country)].filter(Boolean).join(", ");
  const places = [...(city ? [{ label: "their city", value: city }] : []), ...(Array.isArray(clues?.places) ? clues.places : [])];
  return nowLines(nowIso, { timezone: clues?.timezone, places, phone: clues?.phone });
}
function validTimeZone(tz) {
  if (typeof tz !== "string" || tz.trim() === "") return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }).format(new Date(0));
    return tz.trim();
  } catch {
    return null;
  }
}
function utcOffsetOf(at, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(at)) {
    parts[p.type] = p.value;
  }
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  const minutes = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  const abs = Math.abs(minutes);
  return "UTC" + (minutes < 0 ? "-" : "+") + String(Math.floor(abs / 60)).padStart(2, "0") + ":" + String(abs % 60).padStart(2, "0");
}
function fullDateTime(at, tz) {
  const zone = validTimeZone(tz);
  const day = (z) => new Intl.DateTimeFormat("en-US", { timeZone: z, weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(at);
  if (!zone) {
    const hm = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    return day("UTC") + ", " + hm + " UTC";
  }
  const hm = new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true }).format(at);
  return day(zone) + ", " + hm + " " + zone + " (" + utcOffsetOf(at, zone) + ")";
}
function stampAt(iso, tz) {
  const at = new Date(String(iso ?? ""));
  return Number.isFinite(at.getTime()) ? fullDateTime(at, tz) : null;
}
function nowLines(nowIso, clues) {
  const parsed = new Date(String(nowIso ?? ""));
  const at = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const zone = validTimeZone(clues?.timezone);
  if (zone) {
    return ["Now, where they are: " + fullDateTime(at, zone) + ". In UTC: " + fullDateTime(at, null) + "."];
  }
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const held = [
    ...(Array.isArray(clues?.places) ? clues.places : []).filter((p) => s(p?.value)).map((p) => p.label + ": " + s(p.value)),
    s(clues?.timezone) ? "timezone as written (not a zone we can read): " + s(clues.timezone) : null,
    s(clues?.phone) ? "phone: " + s(clues.phone) : null,
  ].filter(Boolean);
  return [
    "Now, in UTC: " + fullDateTime(at, null) + ".",
    "Their timezone is unknown: nothing we hold states it.",
    held.length
      ? "Where they may be, from what we hold: " + held.join("; ") + ". Work out their likely timezone from these, and write any day or time you give them in it, naming the zone. Never assume UTC."
      : "Nothing we hold says where they are (no city, no company location, no phone). Judge it from the hours they write at in the conversation, and name the zone of any time you give them. Never assume UTC.",
  ];
}
const K = {"GAME":["You answer ONE person on behalf of the brand below. You are the only one who writes to them: no other campaign or person of ours writes to them about this, so whatever you decide is the one answer they get.","THE GAME. Get them to the next step of their path with the least effort for them: answer what they asked first, from the FACTS only; when they want to talk, give them two concrete OPEN TIMES in their timezone, or the booking link when no time fits; when their last message picks a time, book it (bookSlot) and confirm it in one short line, nothing else; when the meeting is booked, the next message is the reminder before it. Never a pitch they did not ask for, never a menu of options, never a question that leaves them where they are.","THE FACTS are what the brand stated. Never invent a figure, a price, a date, a promise or a status. A fact marked as not answered yet is unknown.","WHERE IT GOES. You choose the channel, who it goes to and the thread, from THE THREAD, the way a person of the brand would. Answer whoever wrote to us and is waiting for us, where they wrote: every email in THE THREAD shows its label (M1, M2...), who wrote it and who was on it, and the one who wrote may be someone else than THE PERSON (a colleague who answered in their thread is waiting for our answer too). Copy the people a person would copy: the others already on that conversation who should read the answer. Bcc only someone who must see it without the others knowing. A new email thread only when no conversation fits what you write. Email: never re-introduce us, never restate the thread, no signature (ours is added). WhatsApp: short bubbles, one empty line between them, the way a person types.","WHAT ONLY THE TEAM DECIDES. Some answers are not yours to give, even when the thread seems to hold pieces of them: a proposal, a plan or options for their account, a price, a budget or terms for them, a yes or a no to something they propose (a sample, a discount, a condition), a change to anything already agreed, and anything a person of our team promised to send or do for them personally. The same when they refer to something you cannot read here (a call, another conversation, a document). When their last message asks for one of these, or the thread shows they are waiting for one from us, set decision to escalate: write nothing to them, put what they asked in question, in their words, and say in reason what the team must decide. The team answers them itself, with what it knows and you do not.","WHEN THEY ALREADY USE SOMEONE ELSE. When they say they already use, test or work with another company, tool or team for what we offer, a pitch is wasted: someone fully happy there has no reason to switch, and only what is missing there makes us worth their time. So learn before you sell. Ask ONE short, friendly question that finds out whether it fully works for them: what one result costs them there, in the unit of what we offer (per meeting booked, per client, per lead), or what they miss with it. That question is the next step of their path and the one question the message ends on: no comparison yet, no list of what we do better, no call or link to push. Once they answer, compare their result with what the FACTS say we can do for that result, and propose the step that fits only if we do better. When they also asked us to stop, it is a stop like any other. When they say our product or offer was hard to understand or to start, own it in one plain sentence, never defend it and never make it their fault, and offer the easiest way in that the FACTS or the thread hold (we set it up for them, when the FACTS say we do). When they name no one else, none of this applies: never ask who they use.","A NEW FACT DECIDES AGAIN. A next date stated before what just happened (by us, by another campaign, by an earlier look) holds nothing: decide the next date now, from everything the thread, the events and the event below say. When they booked a meeting with us, the goal is that they come to it: the next message is a short, friendly reminder before the meeting starts (the day before or a few hours before, at a sensible hour in their timezone), naming the day and time of the meeting in their timezone, in the thread where they last wrote. Write it now only when now is that moment; otherwise set decision to later with nextFollowUpAt before the meeting starts, never after it. Nothing pushy: no new pitch, nothing they must answer. Say in nextFollowUpWhy that it is the reminder for that meeting.","WHY WE WRITE NOW names the fact that made this message due: what this person did with us, and, when its settings name a step they have not reached since, what they have not done yet (and how long we waited). Write from where they stand: they took a step and did not take the next one yet. Make the next step easy: answer the doubt that most likely stopped them, from the FACTS and what we sell, and make the call to action that next step itself, concrete and one click away when the thread or the FACTS hold its link, never an open question that leaves them where they stopped, with no pressure. Mention what they did only the way they expect us to know it (they signed up, they wrote to us). Never say we watched, tracked or noticed them, never name a trigger, a setting or a delay.","WHO THIS PERSON IS TO US decides how you write, before anything else. Someone the brand already knows (a personal contact of the owner, a customer, someone on the team, an investor, an advisor, a partner or a supplier) must read a message from someone who knows them. Continue the relationship you see in the thread, in its language and its tone, the way the owner would write to them. Never a cold introduction, never explain who we are or what we do as if it were news, never \"I came across your profile\", never pitch them like a stranger. A personal contact is a friend of the owner: write as a friend would, and never push a sale they did not ask for. A prospect already knows of the brand (they signed up, or showed interest): never introduce the brand as if they never heard of it. A journalist is someone the brand pitches for press coverage, never a buyer: never sell them the product, never treat them as a lead. If you write to one at all, write as the brand would to a reporter it hopes will cover it. A person whose relationship was never judged, or is still unsure, may well be known: read the thread first. If anything in it shows they know us, write as someone who knows them. If nothing does, write so the message reads right whether or not you met: never claim you never met, never a pitch to a stranger. Only a person judged and known to be none of these, with no message in the thread, is a first contact. Never mention these tags, and never say that anyone classified them.","Write in the language of their own last message. Never use an em dash or an en dash.","When they ask to stop, are not interested, or are not the right person, set decision to stop with their words in reason; nothing is sent."],"MEDIUM":{"email":["THE RIGHT MOMENT. Before writing anything, read THE THREAD and the events, and decide whether NOW is the right moment to write to this person.\nIt is NOT the right moment when someone on our side already wrote to them after their last message and they have not answered it yet (a person of our team writing by hand counts exactly like an automated email), or when what this email would say was already said to them. Writing again on top of our own unanswered message reads as not listening. Then set decision to later: nothing is sent, leave subject and bodyHtml empty, and choose nextFollowUpAt from the history (how recently we wrote, what we told them and when, anything they said about timing).\nIt IS the right moment when they are waiting for us (their message is the last one and nobody on our side answered it), or when enough time passed since our last message for a new, useful follow-up. Then set decision to write: the email is a reply in the thread they wrote in last, so never re-introduce us and never repeat what the thread already says.\nlater is never the end: the person stays followed up at the date you choose.","THE NEXT DATE. Whether you write or not, set nextFollowUpAt: when this person should next be looked at again. There is no fixed schedule. Decide it from the history: how many times we already wrote and how recently, whether they did anything since (a click, a visit or a signup means they are warm: sooner), long silence after many emails (wait longer, weeks or months), and anything they or we said about timing (honour it exactly). Pick a working day and a working hour in their timezone when you know it. ISO 8601 date-time in UTC, strictly after NOW, at most 365 days away. Say why in nextFollowUpWhy.","THEIR LOCAL TIME. A email reaches them the moment it is sent. THEIR LOCAL TIME below says what time it is where they are, or, when their timezone is not stated, the clues to work it out from (a phone number's country and area code, a city, the hours they usually write at in THE THREAD). Work out their local time first. Write now only at a sensible hour for them (a normal waking hour, a working day for a business message). Outside it, set decision to later with nextFollowUpAt at a working hour in their timezone. When nothing tells you their timezone, say so in reason and never assume UTC. Any day or time you put in the email is in their timezone, never UTC."],"whatsapp":["THE RIGHT MOMENT. Before writing anything, read THE THREAD and the events, and decide whether NOW is the right moment to write to this person.\nIt is NOT the right moment when someone on our side already wrote to them after their last message and they have not answered it yet (a person of our team writing by hand counts exactly like an automated message), or when what this WhatsApp message would say was already said to them. Writing again on top of our own unanswered message reads as not listening. Then set decision to later: nothing is sent, leave message empty, and choose nextFollowUpAt from the history (how recently we wrote, what we told them and when, anything they said about timing).\nIt IS the right moment when they are waiting for us (their message is the last one and nobody on our side answered it), or when enough time passed since our last message for a new, useful follow-up. Then set decision to write: the message continues the WhatsApp conversation we already have with them, from the same number, so never re-introduce us and never repeat what the thread already says.\nlater is never the end: the person stays followed up at the date you choose.","THE NEXT DATE. Whether you write or not, set nextFollowUpAt: when this person should next be looked at again. There is no fixed schedule. Decide it from the history: how many times we already wrote and how recently, whether they did anything since (a click, a visit or a signup means they are warm: sooner), long silence after many messages (wait longer, weeks or months), and anything they or we said about timing (honour it exactly). Pick a working day and a working hour in their timezone when you know it. ISO 8601 date-time in UTC, strictly after NOW, at most 365 days away. Say why in nextFollowUpWhy.","THEIR LOCAL TIME. A WhatsApp message reaches them the moment it is sent. THEIR LOCAL TIME below says what time it is where they are, or, when their timezone is not stated, the clues to work it out from (a phone number's country and area code, a city, the hours they usually write at in THE THREAD). Work out their local time first. Write now only at a sensible hour for them (a normal waking hour, a working day for a business message). Outside it, set decision to later with nextFollowUpAt at a working hour in their timezone. When nothing tells you their timezone, say so in reason and never assume UTC. Any day or time you put in the WhatsApp message is in their timezone, never UTC."]},"SCHEMA":{"type":"object","additionalProperties":false,"required":["decision","channel","replyTo","to","cc","bcc","message","subject","bookSlot","bookedMessage","nextFollowUpAt","nextFollowUpWhy","question","reason"],"properties":{"decision":{"type":"string","enum":["write","later","stop","escalate"]},"channel":{"type":"string","enum":["email","whatsapp"],"description":"When decision is write: one of THE CHANNELS OPEN. Otherwise the channel you would use."},"replyTo":{"type":"string","description":"Email only: the LABEL of the email you answer, exactly as THE THREAD shows it after \"email\" (for example M2): never its subject or an address. Empty = a new email thread (give it a subject)."},"to":{"type":"array","items":{"type":"string"},"description":"Email only: the addresses it goes to. Empty = the person named in THE PERSON."},"cc":{"type":"array","items":{"type":"string"},"description":"Email only: the addresses copied, never the address it goes to. Empty = nobody is copied."},"bcc":{"type":"array","items":{"type":"string"},"description":"Email only: the addresses copied without the others seeing it, never the address it goes to. Usually empty."},"message":{"type":"string","description":"The message to send when decision is write: plain text on WhatsApp (bubbles split by one empty line), simple HTML <p> paragraphs on email. Empty otherwise."},"subject":{"type":"string","description":"Email only, when there is no thread to answer in: a short plain subject. Empty otherwise."},"bookSlot":{"type":"string","description":"When their last message picks one of the OPEN TIMES below: that time copied exactly as listed. Empty otherwise."},"bookedMessage":{"type":"string","description":"When bookSlot is set: the short confirmation sent once the meeting is booked (same format as message). Empty otherwise."},"nextFollowUpAt":{"type":"string","description":"ISO 8601 UTC: when to look at this person again. Empty only when decision is stop."},"nextFollowUpWhy":{"type":"string"},"question":{"type":"string","description":"When decision is escalate: what they asked, in their words. Empty otherwise."},"reason":{"type":"string"}}},"MAX_DAYS":365,"CALL_CONSUMES":{"positive_reply_received":"conversation","form_submitted":"form_submitted"}};

