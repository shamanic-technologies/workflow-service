/**
 * HUMAN-VALIDATED-1124 (owner 2026-11-24: « met de l'human in the loop à chaque étape clé »; « c'est un SCRIPT de
 * l'Engine dont la tactique est "validated by a human", jamais un nouvel objet »).
 *
 * Any script of any Engine can make its Unit only after a person of the brand said yes: the code below is appended to
 * the script, and its tactic `validation: "human"` turns it on (absent = the script makes its Unit at once, the same
 * code: an automatic script and a human-validated one are two dynasties told apart by that tactic alone).
 *
 *   const v = validated(ctx, make, describe);
 *   if (!v || !v.proposal) return v;          // an answer of the world (`unmade`), passed on as it is
 *   ...act on v.proposal, then settle(ctx, v) and return the Unit
 *
 * - `make(feedback)` builds the PROPOSAL (what would become the Unit), usually by asking the Engine before it
 *   (`ctx.ask`); `feedback` is null on a first proposal, else `{words, previous, about}`: the person's own words, the
 *   proposal they refused, and whether they speak of this script's own work (`own`) or of what it was built from
 *   (`source`), so the script re-asks the Engine before it with their words.
 * - `describe(proposal)` says it for a person: `{what, facts[], links[], own, source}`.
 * - The validator is the brand's stated sales rep (brand-service, the person who answers for the brand); the proposal
 *   goes to their WhatsApp from the brand's assistant line (crm-service), written by the model the Rating picks, in
 *   their language. No rep phone = `unmade: no_validator`.
 * - Waiting holds nothing: the proposal is kept in the Engine's storage (`proposals`, one slot per campaign x script
 *   tactics), the script WAITS (`ctx.wait`, resumed by the campaign's next tick, asked scripts included) and reads
 *   the person's thread again. Jev judges what they answered about THIS proposal: yes, a change, or nothing yet.
 *   Never a keyword rule on their words.
 * - An approved proposal stays approved until the script settles it (`settle`), so an act that failed after the yes is
 *   done again without asking twice.
 *
 * The script reads its clock off `ctx.request.now`. Needs PORT_HEAD (`must`) and COMPLETION_HELPERS (`askCompletion`).
 */

/** Minutes between two looks at the person's answer (a campaign rechecks an idle Engine every 10 minutes). */
export const VALIDATION_RECHECK_MINUTES = 5;
/** The Engine storage table the proposals wait in. */
export const PROPOSALS_TABLE = "proposals";
/** The tactic that turns the validation on, and its value. */
export const VALIDATION_TACTIC = "validation";
export const VALIDATED_BY_HUMAN = "human";
/** The sentence a human-validated script's description carries (features-service's Jev judges the tactic on it). */
export const VALIDATED_DESCRIPTION = "A person of the brand validates it first: the brand's assistant sends them the proposal on WhatsApp and nothing is made until they say yes; when they ask for a change, it is redone with their words.";

export const HUMAN_VALIDATION_FNS = `
/** HUMAN-VALIDATED-1124: the brand of the run (one brand: a validation speaks to one brand's person). */
function brandOf(ctx: any): string {
  const r: any = ctx.request ?? {};
  const ids = Array.isArray(r.brandIds) ? r.brandIds : String(ctx.brand ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
  if (ids.length !== 1) throw new Error("the run must be for exactly one brand, it names " + ids.length);
  return String(ids[0]);
}
/** A short stable key of a JSON value (object keys sorted): which script's tactics a proposal was made under. */
function stableKey(v: any): string {
  const canon = (x: any): any => (Array.isArray(x) ? x.map(canon) : x && typeof x === "object" ? Object.keys(x).sort().reduce((o: any, k) => { o[k] = canon(x[k]); return o; }, {}) : x);
  const s = JSON.stringify(canon(v ?? null));
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function noDashes(s: string): string {
  return String(s).replace(/(\\d)\\s*[\\u2013\\u2014]\\s*(\\d)/g, "$1-$2").replace(/\\s*[\\u2013\\u2014]\\s*/g, ", ");
}
/** The person who validates for the brand: its stated sales rep, reached on WhatsApp. */
function validatorOf(ctx: any, brandId: string): { phone: string; firstName: string | null } | null {
  const rep: any = must(ctx, "brand.sales_rep", { params: { brandId } });
  const phone = typeof rep.salesRepPhone === "string" ? rep.salesRepPhone.trim() : "";
  if (!phone) return null;
  return { phone, firstName: typeof rep.salesRepFirstName === "string" && rep.salesRepFirstName.trim() ? rep.salesRepFirstName.trim() : null };
}
/** Their messages with the brand on a personal channel, oldest first (none on record = an empty thread). */
function validatorThread(ctx: any, brandId: string, phone: string): any[] {
  const r: Answer = ctx.vendor.call("crm.person.thread", { query: { brandId, personKey: "phone:" + phone } });
  if (!r.ok) {
    if (r.data.status === 404) return [];
    throw new Error("crm.person.thread failed (" + String(r.data.status ?? "") + "): " + String(r.data.error ?? "").slice(0, 300));
  }
  const failed = (Array.isArray(r.data.sources) ? r.data.sources : []).filter((s: any) => s && s.source === "matrix" && s.status === "failed");
  if (failed.length > 0) throw new Error("the validator's messages could not be read (crm source matrix failed): nothing is judged blind");
  return (Array.isArray(r.data.items) ? r.data.items : []).filter(
    (i: any) => i && i.kind === "message" && i.source === "matrix" && typeof i.text === "string" && i.text.trim() !== "" && typeof i.at === "string",
  );
}
function jevChoice(ctx: any, state: string, instructions: string, criteria: Record<string, string>): string {
  const out: any = must(ctx, "chat.judgment", { body: { state, questions: { q: { type: "choice", instructions, criteria } } } });
  const choice = out && out.answers && out.answers.q ? out.answers.q.choice : null;
  if (typeof choice !== "string" || !(choice in criteria)) throw new Error("the judgment answered no choice among " + Object.keys(criteria).join(", "));
  return choice;
}
/** What the person answered about one proposal, read off their thread since it was sent. */
function readVerdict(ctx: any, state: any, thread: any[]): { kind: "none" } | { kind: "approved"; words: string } | { kind: "change"; words: string; through: string } | { kind: "other"; through: string } {
  const asked = Date.parse(String(state.askedAt));
  const since = thread.filter((i) => Date.parse(i.at) > asked);
  const theirs = since.filter((i) => i.direction === "inbound");
  if (theirs.length === 0) return { kind: "none" };
  const through = String(theirs[theirs.length - 1].at);
  if (state.judgedThrough && Date.parse(through) <= Date.parse(String(state.judgedThrough))) return { kind: "none" };
  const lines = since.map((i) => (i.direction === "inbound" ? "THEM" : "US") + " [" + i.at + "]: " + String(i.text).slice(0, 1500));
  const choice = jevChoice(
    ctx,
    "WHAT WE ASKED THEM TO VALIDATE:\\n" + String(state.message) + "\\n\\nMESSAGES SINCE THEN, oldest first:\\n" + lines.join("\\n"),
    "A person was sent one proposal to validate on WhatsApp. Reading their own messages since then (THEM), what did they answer about THIS proposal?",
    {
      approved: "They accept it as it is: any plain agreement (ok, yes, go, perfect, a thumbs up), in any language.",
      change: "They refuse it or ask for something to be changed, redone or replaced.",
      other: "They have not answered about this proposal yet: their messages are about something else, or ask a question that is neither a yes nor a change.",
    },
  );
  const words = theirs.map((i) => String(i.text).trim()).join("\\n").slice(0, 3000);
  if (choice === "approved") return { kind: "approved", words };
  if (choice === "change") return { kind: "change", words, through };
  return { kind: "other", through };
}
/** Whether a change they ask is about this script's own work, or about what it was built from. */
function changeIsAbout(ctx: any, words: string, own: string, source: string): "own" | "source" {
  if (!source) return "own";
  const choice = jevChoice(
    ctx,
    "WHAT THEY WROTE:\\n" + words,
    "A person asks for a change to a piece of work. Which part do they want changed?",
    { own: "They speak of this: " + own, source: "They speak of this: " + source },
  );
  return choice === "source" ? "source" : "own";
}
/** The proposal, said to the person: written by the model the Rating picks, in their language, as short bubbles. */
function writeProposal(ctx: any, d: any, who: { firstName: string | null }, thread: any[], feedback: any): string[] {
  const r: any = ctx.request ?? {};
  const voice: any = must(ctx, "voice.read", {});
  const tail = thread.slice(-8).map((i) => (i.direction === "inbound" ? "THEM" : "US") + ": " + String(i.text).slice(0, 400));
  const systemPrompt = [
    "You are the assistant of a brand. You write ONE short WhatsApp message to a person of the brand's own team, to ask them to validate a piece of work before it goes further. They are busy and read it on their phone.",
    "Write in the language THEY write in (their last messages below); when they never wrote, the language of the campaign brief; else English.",
    "Two to four short bubbles. Say in plain words what this is, give every link exactly as given (never shortened, never renamed), say what happens once they say ok, and that they can ask for any change in their own words. One idea per bubble. No list of options, no dash, no emoji row.",
    "When this is a new version after a change they asked, open on what changed, in a few words.",
    "Answer as JSON: {\\"bubbles\\": [\\"...\\"]}.",
    "",
    "OUR VOICE (how we write):",
    String(voice.content),
  ].join("\\n");
  const message = [
    "THEIR FIRST NAME: " + (who.firstName ?? "unknown"),
    "WHAT TO VALIDATE: " + String(d.what),
    "FACTS:",
    ...(Array.isArray(d.facts) ? d.facts : []).map((f: any) => "- " + String(f)),
    "LINKS (give each exactly):",
    ...(Array.isArray(d.links) ? d.links : []).map((l: any) => "- " + String(l)),
    "WHAT HAPPENS ON THEIR OK: " + String(d.then ?? "it goes on to the next step"),
    feedback ? "THIS IS A NEW VERSION. THEY HAD ASKED: " + String(feedback.words) : "THIS IS THE FIRST VERSION.",
    typeof r.brief === "string" && r.brief.trim() ? "THE CAMPAIGN BRIEF:\\n" + r.brief.trim().slice(0, 3000) : "",
    "THEIR LAST MESSAGES WITH US, oldest first:",
    ...(tail.length > 0 ? tail : ["(none)"]),
  ].filter((l) => l !== "").join("\\n");
  const json: any = askCompletion(ctx, {
    message,
    systemPrompt,
    responseSchema: { type: "object", additionalProperties: false, required: ["bubbles"], properties: { bubbles: { type: "array", items: { type: "string" } } } },
  }).data.json;
  const bubbles = (json && Array.isArray(json.bubbles) ? json.bubbles : []).map((b: any) => noDashes(String(b)).trim()).filter(Boolean);
  if (bubbles.length === 0) throw new Error("the proposal message came back empty: nothing is sent");
  // crm-service sends at most five bubbles: past five, the rest joins the last one, nothing is dropped.
  return bubbles.length <= 5 ? bubbles : [...bubbles.slice(0, 4), bubbles.slice(4).join("\\n\\n")];
}
function sendProposal(ctx: any, brandId: string, phone: string, bubbles: string[], key: string): { refused: string } | { sentAt: string | null } {
  const r: any = ctx.request ?? {};
  const body: any = { brandId, phone, idempotencyKey: key };
  if (bubbles.length === 1) body.text = bubbles[0];
  else body.messages = bubbles;
  // The line the campaign states, else the brand's assistant line (every automated message but the founder's hello).
  if (typeof r.whatsappSenderPhone === "string" && r.whatsappSenderPhone.trim()) body.fromAccount = r.whatsappSenderPhone.trim();
  else body.fromLine = "assistant";
  // Not the campaign speaking to a lead: crm-service would file a campaign-attributed send as a campaign thread.
  const a: Answer = ctx.vendor.call("crm.whatsapp.send", { body, omitHeaders: ["x-campaign-id"] });
  if (a.ok) return { sentAt: typeof a.data.sentAt === "string" ? a.data.sentAt : null };
  if (typeof a.data.status !== "number" || typeof a.data.code !== "string" || !a.data.code) throw new Error("crm.whatsapp.send failed (" + String(a.data.status ?? "") + "): " + String(a.data.error ?? "").slice(0, 300));
  return { refused: a.data.code + ": " + String(a.data.error ?? "the proposal could not be sent") };
}
/**
 * The proposal a script may act on: made at once (no validation tactic), or approved by the brand's person. Returns
 * {proposal, slot?} to act on, an answer of the world ({unmade...}) to return as it is, or WAITS for their answer.
 */
function validated(ctx: any, make: (feedback: any) => any, describe: (proposal: any) => any): any {
  const t: any = ctx.tactics ?? {};
  if (t.${VALIDATION_TACTIC} !== "${VALIDATED_BY_HUMAN}") return make(null);
  const r: any = ctx.request ?? {};
  const now = String(r.now ?? "");
  if (!now) throw new Error("the run states no clock (request.now)");
  const brandId = brandOf(ctx);
  const who = validatorOf(ctx, brandId);
  if (!who) return { unmade: "no_validator: the brand states no sales rep phone, so nobody can validate" };
  const slot = String(r.campaignId ?? "no-campaign") + "|" + stableKey(t);
  const state: any = ctx.storage.get("${PROPOSALS_TABLE}", slot);
  if (state && state.state === "approved") return { proposal: state.proposal, slot };
  const thread = validatorThread(ctx, brandId, who.phone);
  let feedback: any = null;
  let rounds = 0;
  if (state && state.state === "asked") {
    const v = readVerdict(ctx, state, thread);
    if (v.kind === "other") ctx.storage.set("${PROPOSALS_TABLE}", slot, { ...state, judgedThrough: v.through });
    if (v.kind === "none" || v.kind === "other") ctx.wait(${VALIDATION_RECHECK_MINUTES} / 1440);
    if (v.kind === "approved") {
      ctx.storage.set("${PROPOSALS_TABLE}", slot, { ...state, state: "approved", approvedAt: now, approvedWords: (v as any).words });
      return { proposal: state.proposal, slot };
    }
    const d0: any = describe(state.proposal);
    feedback = { words: (v as any).words, previous: state.proposal, about: changeIsAbout(ctx, (v as any).words, String(d0.own ?? ""), String(d0.source ?? "")) };
    rounds = Number(state.rounds ?? 0) + 1;
  }
  const made: any = make(feedback);
  if (!made || !made.proposal) return made ?? null;
  const d: any = describe(made.proposal);
  const bubbles = writeProposal(ctx, d, who, thread, feedback);
  const sent: any = sendProposal(ctx, brandId, who.phone, bubbles, "validation:" + slot + ":" + stableKey(made.proposal));
  if (sent.refused) return { unmade: sent.refused };
  ctx.storage.set("${PROPOSALS_TABLE}", slot, { state: "asked", proposal: made.proposal, message: bubbles.join("\\n\\n"), askedAt: sent.sentAt ?? now, rounds, validator: who.phone });
  ctx.wait(${VALIDATION_RECHECK_MINUTES} / 1440);
}
/** The act is done: the approved proposal leaves the slot (the next run makes a new one). */
function settle(ctx: any, v: any): void {
  if (v && typeof v.slot === "string") ctx.storage.delete("${PROPOSALS_TABLE}", v.slot);
}
`;
