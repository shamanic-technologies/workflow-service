/**
 * A follow-up taken by a run that then FAILS comes back within the hour (FAILED-RUN-RELEASE-1126).
 *
 * lead-service hands a due follow-up to a campaign and holds the person's one date 7 days out
 * (ONE-PERSON-ONE-SERVE-1125: « until the holder sends or states a date »), so no other campaign of the brand takes
 * them meanwhile. A run that crashed after the serve (a 502 on the send gate, a writer that failed) neither sent nor
 * stated anything: the person waited a full week for a follow-up nobody wrote (prod 2026-11-26: 9 follow-ups of
 * « Active Follow-up Replies » failed on crm-service timeouts, each lead pushed to 2026-12-03).
 *
 * One rule for every script, read off its own door calls: a run that ends failed or stopped after a successful
 * `lead.serve` that found a person, with no successful date statement or send of its own, states the person's next
 * follow-up date one hour out, with the failure as its reason. A run that sent or stated a date keeps what it stated;
 * a run that served nobody touches nothing.
 */

export const RELEASE_AFTER_FAILURE_MS = 60 * 60_000;

/** The doors whose success means the run already left the person a date (a send sets it in the common sending code). */
const DATE_LEAVING_DOORS = new Set(["lead.followup_date.set", "lead.followup.record", "email.send", "crm.whatsapp.send"]);

export interface ServedHold {
  /** The lead row id the serve handed (`lead.leadCampaignId`), what `PUT /orgs/leads/{id}/followup-date` takes. */
  rowId: string | null;
  brandId: string | null;
  /** A door call of this run already sent or stated a date. */
  dateLeft: boolean;
}

export function newServedHold(): ServedHold {
  return { rowId: null, brandId: null, dateLeft: false };
}

/** PURE: what one door answer tells about the served person. */
export function noteDoorAnswer(hold: ServedHold, name: string, answer: { ok: boolean; data?: unknown }): void {
  if (!answer.ok) return;
  if (DATE_LEAVING_DOORS.has(name)) {
    hold.dateLeft = true;
    return;
  }
  if (name !== "lead.serve") return;
  const data = (answer.data ?? null) as { found?: unknown; lead?: { leadCampaignId?: unknown; brandIds?: unknown } } | null;
  if (data?.found !== true) return;
  const rowId = data.lead?.leadCampaignId;
  const brandIds = data.lead?.brandIds;
  if (typeof rowId !== "string" || rowId === "") return;
  hold.rowId = rowId;
  hold.brandId = Array.isArray(brandIds) && typeof brandIds[0] === "string" ? brandIds[0] : null;
}

/** PURE: the date statement a failed run owes its served person, or null when it owes none. */
export function releaseStatement(
  hold: ServedHold,
  status: string,
  error: string | null,
  now: Date,
): { params: { id: string }; query: { brandId: string } | Record<string, never>; body: { nextFollowupAt: string; reason: string } } | null {
  if (status !== "failed" && status !== "stopped") return null;
  if (!hold.rowId || hold.dateLeft) return null;
  const why = (error ?? "no error stated").replace(/\s+/g, " ").slice(0, 200);
  return {
    params: { id: hold.rowId },
    query: hold.brandId ? { brandId: hold.brandId } : {},
    body: {
      nextFollowupAt: new Date(now.getTime() + RELEASE_AFTER_FAILURE_MS).toISOString(),
      reason: `The run that took this follow-up failed before sending (${why}); asked again in 1 hour`,
    },
  };
}
