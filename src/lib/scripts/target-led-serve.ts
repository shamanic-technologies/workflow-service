/**
 * TARGET-LED-SERVE-1121 (OUTREACH-3WAYS-1121): WHO a cold email sender writes to on a campaign launched on its TARGET
 * alone (no channel, no sales funnel: campaign-service `/start-run` states `featureSlug: null`).
 *
 * Such a campaign has no sourcing leg of its own, so the sender's own `lead.serve` walked the offer's BUYERS whatever
 * the brief asked: our "industry peers" campaign wrote to a buyer (2026-11-21, Sarah Davis, NextGen Healthcare) and the
 * "investors" one was one model hang-up away from the same. The person is now the one the campaign's Lead found Engine
 * finds (`ctx.ask` then `ctx.get("lead_found")`: the Rating picks among the scripts the campaign's strategy keeps, e.g.
 * `lead_found/dy_lead_serve_brand_investors`, serve `{population: "investors"}`), then served here BY NAME
 * (lead-service `namedLead`, keyed on that Lead found run: never `population` beside it, never this script's own serve
 * tactic merged in). Nobody found = nothing made (the Engine's own reason, `audience_exhausted` included), never a
 * fallback to the buyers' serve.
 *
 * A run stating a channel (every funnel campaign), a run answering an occurrence that names its person, and a recorded
 * case whose request states no `featureSlug` at all keep the code byte for byte: only `featureSlug === null` asks.
 *
 * Applied to the STORED code of every cold email sender by one anchored edit (an UPGRADE of each dynasty, never a fork);
 * a moved anchor = nothing generated.
 */

/** The senders whose stored code serves its own person (`lead.serve` with its `serve` tactic). */
export const TARGET_LED_SENDERS = [
  { outcome: "email_sent", dynasty: "dy_cold_email" },
  { outcome: "email_sent", dynasty: "dy_cold_email_site" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_sender_client_brand" },
] as const;

export const LEAD_FOUND_OUTCOME = "lead_found";

const ANCHOR = '  const serve = ctx.vendor.call("lead.serve", { ...(tactics.serve ?? {}), ...(named ? { namedLead: named } : {}) });';

const REPLACEMENT = `  // TARGET-LED-SERVE-1121: a campaign launched on its Target alone (no channel) has no sourcing leg of its own: the
  // person is the one its Lead found Engine finds under the campaign's strategy (the brand's investors, its industry
  // peers...), served here by name. Nobody found = nothing made, never this script's own serve.
  let serveBody: Record<string, any> = { ...(tactics.serve ?? {}), ...(named ? { namedLead: named } : {}) };
  if (!named && req.featureSlug === null) {
    ctx.ask({ units: {}, request: req });
    const found = ctx.get("lead_found") as Record<string, any>;
    if (!found || !found.content) {
      const why = String((found && found.unmade) || "nobody");
      return why === "serve_timed_out" ? { unmade: why, again: true } : { unmade: why };
    }
    const foundLeadId = typeof found.content.leadId === "string" ? found.content.leadId : "";
    if (!foundLeadId) throw new Error("lead_found made a Unit naming no leadId");
    const foundRun = found.run && typeof found.run.runId === "string" ? found.run.runId : String(found.id);
    serveBody = { namedLead: { leadId: foundLeadId, triggerEventId: "lead_found:" + foundRun } };
  }
  const serve = ctx.vendor.call("lead.serve", serveBody);`;

/** The stored sender's code, asking the Lead found Engine on a channel-less campaign. Throws when the anchor moved. */
export function addTargetLedServe(code: string): string {
  if (code.includes("TARGET-LED-SERVE-1121")) throw new Error("target-led-serve: the stored code already asks the Lead found Engine");
  const at = code.indexOf(ANCHOR);
  if (at < 0 || code.indexOf(ANCHOR, at + 1) >= 0) throw new Error("target-led-serve: the serve line is not found exactly once: nothing generated");
  return code.slice(0, at) + REPLACEMENT + code.slice(at + ANCHOR.length);
}

/** The tactics: `asks` gains Lead found (the Rating draws the sender for a run that does not hold one). */
export function targetLedServeTactics(tactics: Record<string, unknown>): Record<string, unknown> {
  const asks = Array.isArray(tactics.asks) ? (tactics.asks as unknown[]).filter((a) => a !== LEAD_FOUND_OUTCOME) : [];
  return { ...tactics, asks: [...asks, LEAD_FOUND_OUTCOME] };
}
