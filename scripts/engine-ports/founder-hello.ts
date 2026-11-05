/**
 * MIGRATE-1105 S4: the founder hello (`conversation`) as ONE stored script, ported from the Founder Hello workflow DAG
 * (`founder-hello-dag.ts`) step by step (`buildFounderHelloSource()` assembles it from the DAG's own step code). A
 * person who just set up the brand's product and gave their WhatsApp number gets ONE hello from the founder, naming
 * what they set up, then (when the brand has one) the assistant's first message from the assistant's own line:
 *
 *   lead-service       claims the occurrence's person on this campaign's own queue (only a run whose trigger names one);
 *   crm-service        this campaign's WhatsApp sends to them + their whole thread (once per person, never someone
 *                      already talking with the brand on WhatsApp), then our staff / the brand's own team check;
 *   crm-service        the reach check from the brand's FOUNDER line (the sending persona, the assistant line);
 *   brand-service      the brand profile and its sales rep;
 *   crm-service        the founder's own hand-typed messages to up to 3 business contacts (his rhythm), each checked
 *                      not to be our staff or the brand's team;
 *   features-service   the pipe's best template dynasty + LLM for this campaign (never fixed here);
 *   content-generation the hello (and the assistant's first message, after the marker), written with that head + LLM;
 *   crm-service        the hello from the founder line, then the assistant's message from the assistant line;
 *   lead-service       the queue row stopped strictly after the send.
 *
 * NO DRY RUN: a live Engine run is never a staff replay, so the DAG's `inputs.dryRun` / `inputs.replayToPhone` paths
 * (dry-summary, the replay sends) are not driven: the plan is always called with dryRun false and replayToPhone null,
 * so their branches inside the step code are unreachable, and the chassis (gate, start, end) is the Engine runner's.
 *
 * Answers, exactly the DAG's end-runs: `null` = nobody due (idle); `{content: {end}}` = the hello went out;
 * `unmade "person_not_admitted: <reason>"` = already greeted / already talking / staff / own team / the brand stated
 * they are not someone of theirs (final); `unmade "<code>: <reason>"` = crm-service refused WhatsApp for this person
 * (final); a throw = the run failed (redelivered: unclaimed, other person, any read or send failure).
 * Tactics: `channel` founder-hello (the campaign's), `recorded_by` crm (crm-service records the send).
 */
import { asFunction, PORT_HEAD } from "./port-kit.js";
import {
  ADMISSION_CODE,
  ASSISTANT_PLAN_CODE,
  COMPOSE_CODE,
  FINALIZE_CODE,
  FOUNDER_HELLO_FEATURE_SLUG,
  FOUNDER_HELLO_REFUSAL_CODES,
  OUTCOME_CODE,
  PICK_PERSON_CODE,
  PLAN_CLAIM_CODE,
  REACH_PLAN_CODE,
  REACH_VERDICT_CODE,
  VOICE_PLAN_CODE,
  VOICE_SAMPLE_PEOPLE,
} from "../../src/lib/founder-hello-dag.js";
import { CLAIM_PERSON_CODE } from "../../src/lib/claim-person.js";
import { SENDER_PERSONA_FN } from "../../src/lib/sender-persona.js";
import { WHATSAPP_WRITER_PLAN_CODE } from "../../src/lib/whatsapp-template-writer.js";
import { SETTLED_THREAD_WAIT } from "../../src/lib/dag-to-openflow.js";

export const FOUNDER_HELLO_OUTCOME = "conversation";
export const FOUNDER_HELLO_DYNASTY = "dy_founder_hello";
export const FOUNDER_HELLO_TACTICS = { channel: FOUNDER_HELLO_FEATURE_SLUG, recorded_by: "crm" };

/** The compose step's one clock read: the run's date is always handed to it (`ctx.request.now`), never Date.now(). */
const COMPOSE_CLOCK = "String(currentDate ?? new Date().toISOString().slice(0, 10))";

/**
 * Compose and the reach verdict both carry `senderPersona`/`personaLines` (each Windmill step is its own module); one
 * script is one module, so compose keeps the verdict's copy (byte-identical text, the same functions).
 */
function composeFunction(): string {
  if (!COMPOSE_CODE.includes(COMPOSE_CLOCK)) throw new Error("founder-hello: the compose step's clock read changed; re-port it");
  if (!COMPOSE_CODE.includes(SENDER_PERSONA_FN)) throw new Error("founder-hello: the compose step no longer carries the sender persona; re-port it");
  if (!REACH_VERDICT_CODE.includes(SENDER_PERSONA_FN)) throw new Error("founder-hello: the reach verdict no longer carries the sender persona; re-port it");
  return asFunction(COMPOSE_CODE.replace(COMPOSE_CLOCK, "String(currentDate)").replace(SENDER_PERSONA_FN, ""), "compose");
}

export function buildFounderHelloSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Founder hello (conversation): one WhatsApp hello from the founder to a person who just set up the product (MIGRATE-1105 S4). */`,
    `const BRIEF_HEADER = "";`,
    PORT_HEAD,
    asFunction(CLAIM_PERSON_CODE, "claimPersonOf"),
    asFunction(PLAN_CLAIM_CODE, "planClaim"),
    asFunction(PICK_PERSON_CODE, "pickPerson"),
    asFunction(ADMISSION_CODE, "admissionOf"),
    asFunction(REACH_PLAN_CODE, "reachPlanOf"),
    asFunction(REACH_VERDICT_CODE, "reachVerdictOf"),
    asFunction(VOICE_PLAN_CODE, "voicePlanOf"),
    composeFunction(),
    asFunction(WHATSAPP_WRITER_PLAN_CODE, "writerPlan"),
    asFunction(FINALIZE_CODE, "finalize"),
    asFunction(ASSISTANT_PLAN_CODE, "assistantPlanOf"),
    asFunction(OUTCOME_CODE, "outcomeOf"),
    `
const FEATURE = ${JSON.stringify(FOUNDER_HELLO_FEATURE_SLUG)};
const REFUSAL_CODES: string[] = ${JSON.stringify([...FOUNDER_HELLO_REFUSAL_CODES])};
const SETTLED = ${JSON.stringify(SETTLED_THREAD_WAIT)};
const VOICE_SAMPLES = ${VOICE_SAMPLE_PEOPLE};
/** What an http.call step answered when its \`skip\` was true. */
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

/** The sender's human sentence on a refusal body (http-call readRefusalReason): \`details\` when a sentence, else \`error\`. */
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

/** A WhatsApp send with the DAG's \`skipOnRefusalCodes\`: a named 4xx refusal is the http.call step's skipped answer, anything else throws. */
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
  const pick = skipWrite ? NOT_CALLED : must(ctx, "features.writer_pick", { query: { campaignId } });
  const writer = writerPlan(pick, skipWrite);
  const head = skipWrite ? NOT_CALLED : must(ctx, "content.template_head", { params: { slug: writer.templateDynastySlug } });
  const draft = skipWrite
    ? NOT_CALLED
    : must(ctx, "content.whatsapp.generate", {
        body: {
          featureSlug: FEATURE,
          context: composed.message,
          variables: composed.variables,
          campaignId,
          leadId: person.leadId,
          type: head.template.type,
          model: writer.model,
          ...(R.brief !== null && R.brief !== undefined ? { brief: R.brief } : {}),
        },
      });
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
`,
  ].join("\n");
}
