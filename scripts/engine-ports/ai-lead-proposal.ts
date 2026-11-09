/**
 * MIGRATE-1105 S4: the hot-lead proposal as ONE stored script, ported from the AI Lead Proposal workflow DAG
 * (`ai-lead-proposal-dag.ts`) step by step: a lead who wants to do business became hot; the brand's Copilot is asked
 * for ONE proactive turn toward the brand's team (who they are, what they wrote, one proposal). Nothing is sent to
 * the person.
 *
 *   lead-service    claims the occurrence's person on this campaign's queue, leads only (`pure_prospect`);
 *   crm-service     their latest inbound message (tolerated: the Copilot reads the thread itself);
 *   chat-service    the proactive Copilot turn, idempotent on the FACT (never the run, never the offer);
 *   lead-service    the row stopped `hot_lead_proposed` / `hot_lead_no_copilot_user`;
 *   (the run is marked support `copilot` by the Engine runner, tactic `support`: the turn produces no outcome by design).
 *
 * Answers: `null` = nothing to do now (no occurrence, relationship not judged yet), `unmade
 * "person_not_admitted: <reason>"` = not a lead of the brand (final), `unmade "no_copilot_user: <why>"` = nobody to
 * tell (final), `{content: {end}}` = asked, a throw = the run failed (redelivered), exactly the DAG's ends.
 */
import { asFunction, PORT_HEAD } from "./port-kit.js";
import {
  AI_LEAD_PROPOSAL_FEATURE_SLUG,
  AI_LEAD_PROPOSAL_SUPPORT_REASON,
  CLAIMED_CODE,
  COMPOSE_TURN_CODE,
  HOT_LEAD_NO_COPILOT_USER_REASON,
  HOT_LEAD_PROPOSED_REASON,
  NO_COPILOT_USER_CODE,
  PLAN_CLAIM_CODE,
} from "../../src/lib/ai-lead-proposal-dag.js";
import { ANSWERS_LEADS_ONLY_POLICY } from "../../src/lib/answering-steps.js";
import { SETTLED_THREAD_WAIT } from "../../src/lib/dag-to-openflow.js";

export const AI_LEAD_PROPOSAL_OUTCOME = "paid_client";
export const AI_LEAD_PROPOSAL_DYNASTY = "dy_hot_lead_proposal";
export const AI_LEAD_PROPOSAL_TACTICS = {
  channel: AI_LEAD_PROPOSAL_FEATURE_SLUG,
  recorded_by: "chat",
  support: { kind: "copilot", reason: AI_LEAD_PROPOSAL_SUPPORT_REASON },
};

/** The one awaited line of the claim step (WebCrypto), as the same digest computed in plain JS. */
const DIGEST_LINE = `const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(item.companyKey));
      company = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);`;

/** SHA-256 of a string's UTF-8 bytes, hex (FIPS 180-4), for the sandbox, which ships no WebCrypto. */
export const SHA256_HEX = `
function sha256Hex(text: string): string {
  const bytes: number[] = [];
  for (const ch of unescape(encodeURIComponent(text))) bytes.push(ch.charCodeAt(0));
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const W = new Array<number>(64);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let t = 0; t < 16; t++) W[t] = (bytes[off + 4 * t]! << 24) | (bytes[off + 4 * t + 1]! << 16) | (bytes[off + 4 * t + 2]! << 8) | bytes[off + 4 * t + 3]!;
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15]!, 7) ^ rotr(W[t - 15]!, 18) ^ (W[t - 15]! >>> 3);
      const s1 = rotr(W[t - 2]!, 17) ^ rotr(W[t - 2]!, 19) ^ (W[t - 2]! >>> 10);
      W[t] = (W[t - 16]! + s0 + W[t - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const t1 = (h + S1 + ((e & f) ^ (~e & g)) + K[t]! + W[t]!) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0]! + a) | 0; H[1] = (H[1]! + b) | 0; H[2] = (H[2]! + c) | 0; H[3] = (H[3]! + d) | 0;
    H[4] = (H[4]! + e) | 0; H[5] = (H[5]! + f) | 0; H[6] = (H[6]! + g) | 0; H[7] = (H[7]! + h) | 0;
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, "0")).join("");
}
`;

export function buildAiLeadProposalSource(): string {
  if (!CLAIMED_CODE.includes(DIGEST_LINE)) throw new Error("ai-lead-proposal: the claim step's digest changed; re-port it");
  const claimed = asFunction(CLAIMED_CODE.replace(DIGEST_LINE, `company = sha256Hex(item.companyKey).slice(0, 16);`), "claimedOf");
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** AI lead proposal: one proactive Copilot turn telling the brand's team about a hot lead (MIGRATE-1105 S4). */`,
    `const BRIEF_HEADER = "";`,
    PORT_HEAD,
    SHA256_HEX,
    `const SETTLED_THREAD_WAIT = ${JSON.stringify(SETTLED_THREAD_WAIT)};`,
    asFunction(PLAN_CLAIM_CODE, "planClaim"),
    claimed,
    asFunction(COMPOSE_TURN_CODE, "composeTurn"),
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const trigger = R.trigger ?? null;
  const campaignId = R.campaignId;
  const plan = planClaim(trigger);
  const claim = plan.skip === true ? { ok: false, notCalled: true } : must(ctx, "lead.followup.claim", { params: { campaignId }, body: { relationships: ${JSON.stringify(ANSWERS_LEADS_ONLY_POLICY)} } });
  const c = claimedOf(plan, claim, trigger, R.orgId, (Array.isArray(R.brandIds) && R.brandIds.length ? R.brandIds.join(",") : ctx.brand));
  if (c.outcome === "nobody_due" || c.outcome === "pending") return null;
  if (c.outcome === "not_admitted") return { unmade: "person_not_admitted: " + String(c.notAdmitted?.reason ?? "") };
  if (c.outcome === "other_person") throw new Error("ai-lead-proposal: claimed someone the occurrence does not name: their row is left alone");
  if (c.outcome === "unclaimed") throw new Error("ai-lead-proposal: the occurrence's person was made due but nobody could be claimed");
  const timeline = c.skipTimeline === true ? { ok: false, notCalled: true } : tolerated(ctx, "crm.person.thread", { query: c.timelineQuery, pollWhile: SETTLED_THREAD_WAIT });
  const turn = composeTurn(c, timeline);
  const asked: Answer = ctx.vendor.call("chat.copilot.proactive_turn", { body: turn.request });
  const stopRow = (reason: string) => must(ctx, "lead.followup.record", { params: { id: c.rowId }, body: { kind: "stopped", reason } });
  if (!asked.ok) {
    const body: any = asked.data.body ?? {};
    if (asked.data.status === 409 && body.error === ${JSON.stringify(NO_COPILOT_USER_CODE)}) {
      stopRow(${JSON.stringify(HOT_LEAD_NO_COPILOT_USER_REASON)});
      const why = typeof body.detail === "string" && body.detail ? body.detail : ${JSON.stringify(NO_COPILOT_USER_CODE)};
      return { unmade: ${JSON.stringify(NO_COPILOT_USER_CODE)} + ": " + why };
    }
    throw new Error("[ai-lead-proposal] the proactive turn was not accepted (" + String(asked.data.status) + "): " + String(asked.data.error ?? "").slice(0, 500));
  }
  if (typeof asked.data.id !== "string" || !asked.data.id) throw new Error("[ai-lead-proposal] chat-service answered without a turn id: " + JSON.stringify(asked.data));
  stopRow(${JSON.stringify(HOT_LEAD_PROPOSED_REASON)});
  return { content: { end: { success: true, stopCampaign: false, delivery: { state: "delivered" } } } };
}
`,
  ].join("\n");
}
