/**
 * PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2: the lead follow-up sender (`lead_interested/dy_follow_up_due`) on a campaign
 * launched on its TARGET alone (no channel, `request.featureSlug === null`) takes its person from its Lead found Engine,
 * served by name, exactly as the cold email senders do (TARGET-LED-SERVE-1121). Without it, its own serve on such a run
 * walks the brand's audiences and hands it a FRESH person, who would get a « follow-up » from someone who never wrote to
 * them. The campaign's strategy picks the Lead found script (a « follow up people already emailed » brief keeps the
 * due follow-ups' serve). A run naming its person (an occurrence) or carrying a channel is byte for byte as before.
 * Anchored edit of the STORED code; a moved anchor = nothing generated.
 */
const SERVE_ANCHOR =
  'results.serve_lead = callStep(ctx, "lead.serve", { service: "lead", method: "POST", path: "/orgs/buffer/next", body: (({namedLead: ((t) => (t && typeof t.leadId === "string" && t.leadId ? { leadId: t.leadId, triggerEventId: t.eventId } : undefined))(flow_input.trigger)})) }, 0);';
const MARK = "PLAN-RECURSIVE-PER-ENGINE-1124-WF3 B2";

const TARGET_LED = `// ${MARK}: a campaign launched on its Target alone takes its person from its Lead found Engine, by name.
  let TARGET_LED: any = undefined;
  if (!(flow_input.trigger && typeof flow_input.trigger.leadId === "string" && flow_input.trigger.leadId) && R.featureSlug === null) {
    ctx.ask({ units: {}, request: R });
    const found: any = ctx.get("lead_found");
    if (!found || !found.content) {
      const why = String((found && found.unmade) || "nobody");
      return why === "serve_timed_out" ? { unmade: why, again: true } : { unmade: why };
    }
    const foundLeadId = typeof found.content.leadId === "string" ? found.content.leadId : "";
    if (!foundLeadId) throw new Error("lead_found made a Unit naming no leadId");
    const foundRun = found.run && typeof found.run.runId === "string" ? found.run.runId : String(found.id);
    TARGET_LED = { leadId: foundLeadId, triggerEventId: "lead_found:" + foundRun };
  }
  `;

export function addFollowUpTargetLed(code: string): string {
  if (code.includes(MARK)) throw new Error("follow-up target-led serve: already in the code");
  if (code.split(SERVE_ANCHOR).length !== 2) throw new Error("follow-up target-led serve: the serve anchor is not found exactly once");
  const served = SERVE_ANCHOR.replace("body: (({namedLead: ((t)", "body: (({namedLead: TARGET_LED ?? ((t)");
  return code.replace(SERVE_ANCHOR, TARGET_LED + served);
}

/** Tactics of the upgraded version: Lead found is asked. */
export function followUpTargetLedTactics(tactics: Record<string, unknown>): Record<string, unknown> {
  const asks = Array.isArray(tactics.asks) ? (tactics.asks as unknown[]).map(String) : [];
  return { ...tactics, asks: asks.includes("lead_found") ? asks : [...asks, "lead_found"] };
}
