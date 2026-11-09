/**
 * BACKLINK-ENGINE-1109 (owner 2026-11-09 « go »: earning backlinks is an Engine of a brand like any client work; owner
 * 2026-11-08: « Précis dans le WHAT pour le naming, mais pas dans le comment, qui doit être des tactiques »): the
 * Backlink Engine (`backlink_earned` « Backlink earned »). One Unit = one new live link from another domain to the
 * brand's site, verified on the referring page.
 *
 * This first script (`dy_backlink_check`) confirms the links the brand earned, however they were earned (a directory
 * listing, a listicle outreach, a guest post): one check a day through scraping-service's door `scraping.backlinks.check`.
 * scraping-service reads the domains linking to the brand's site through treg (held + actualized on its run under this
 * script's), verifies each one live on its referring page, keeps every link NEW for the brand and declares one Unit per
 * kept link on that same run (the door fills `outcomeKey` with this Engine's outcome; `recorded_by` scraping), so the
 * Units and every cent sit on one run of the campaign.
 *
 * The HOW lives in the tactics, never in the outcome: `how` (what earned the link), `windowDays` (how far back a brand's
 * first check reaches: older links were not earned by this work), `provider` (who reads the links, scraping-service's
 * closed list; absent = its default). The day's idempotency key makes a second run the same day answer the completed
 * check again: no second spend.
 * Answers: `{content: {checked, links}}` = today's new links; `unmade "no_new_link: ..."` = nothing new today; a throw =
 * the run failed (a refused spend, the brand has no site).
 */
import { PORT_HEAD } from "./port-kit.js";

export const BACKLINK_CHECK = {
  outcome: "backlink_earned",
  dynasty: "dy_backlink_check",
  tactics: {
    recorded_by: "scraping",
    how: "confirms every new link to the brand's site, however it was earned (directory listing, listicle outreach, guest post)",
    windowDays: 60,
  },
  description:
    "Checks once a day which other websites link to the brand's site, confirms each new link is live on its page, and counts every new one as a backlink earned.",
} as const;

export function buildBacklinkCheckSource(): string {
  return [
    `import type { ScriptContext, ScriptResult } from "@gtm-factory/core";`,
    `/** Backlink earned: one check a day of the brand's site, each new live link kept as one Unit by scraping-service (BACKLINK-ENGINE-1109). */`,
    PORT_HEAD,
    `
export default function run(ctx: ScriptContext): ScriptResult {
  const R: any = ctx.request ?? {};
  const now = typeof R.now === "string" ? R.now : "";
  const day = now.slice(0, 10);
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) throw new Error("backlink-check: the run states no clock (request.now): " + JSON.stringify(R.now));
  const t: any = ctx.tactics ?? {};
  const windowDays = Number.isInteger(t.windowDays) && t.windowDays > 0 && t.windowDays <= 365 ? t.windowDays : 60;
  const body: Record<string, unknown> = { windowDays, idempotencyKey: "backlinks:" + day };
  if (typeof t.provider === "string" && t.provider) body.provider = t.provider;
  const check = must(ctx, "scraping.backlinks.check", { body });
  const links = Array.isArray(check.newLinks) ? check.newLinks : [];
  if (!links.length) {
    const rejected = Array.isArray(check.rejected) && check.rejected.length ? " (" + check.rejected.length + " candidate links not live or not to the brand)" : "";
    return { unmade: "no_new_link: no new live link to the brand's site today" + rejected };
  }
  const view = links.map((l: any) => ({ id: l.id, referringDomain: l.referringDomain ?? null, referringUrl: l.referringUrl ?? null, targetUrl: l.targetUrl ?? null, domainRank: l.domainRank ?? null, firstSeenAt: l.firstSeenAt ?? null }));
  return { content: { checked: check.replayed !== true, links: view } };
}
`,
  ].join("\n");
}
