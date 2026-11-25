/**
 * MOST-UNITS-PACE-1125 (framework: « Daily caps in the brief become most Units per day at an Engine »; owner 2026-11-25:
 * Threads Posts publishes at most ONE Threads post a day). features-service judges the pace a campaign's brief states
 * and serves it per Engine on `GET /internal/script-strategy?campaignId=&outcome=` as `mostUnits`
 * (`{units, per: day | week | month, days: 1 | 7 | 30} | null`; null = the brief states no pace on that Engine = no cap,
 * never a default). Once the campaign's Units of the Engine's outcome made in the last `days` x 24 h (a ROLLING window)
 * reach `units`, a run of that Engine, direct or asked by another script of the same campaign, makes nothing: it answers
 * `unmade` decided `idle` with the code `most_units_reached` (an expected hold, never a failure, never red).
 *
 * The count is the LEDGER's (runs-service `GET /internal/outcome-occurrences`, produced, never reversed, carrying the
 * campaign's tag): a Unit declared by the owning service (social-service, meta-service) counts like one the runner
 * declares. Unreadable = throws: the run makes nothing and is retried, never a run past an unread cap.
 * Never a cap in code, a default pace, or a per-Engine rule: the brief states it, features-service serves it.
 */

export interface MostUnits {
  units: number;
  per: "day" | "week" | "month";
  days: number;
}

export const MOST_UNITS_REACHED = "most_units_reached";

/** features-service's whole answer to one strategy read, kept a minute so a run's pace and pick read it once. */
export interface StrategyAnswer {
  keptDynasties: string[];
  mostUnits: MostUnits | null;
}

const STRATEGY_TTL_MS = 60_000;
const strategyCache = new Map<string, { at: number; answer: Promise<StrategyAnswer> }>();

/** Parses `mostUnits` as served; anything else than null or the served shape throws (a contract we cannot read). */
export function parseMostUnits(v: unknown, where: string): MostUnits | null {
  if (v === null || v === undefined) return null;
  const o = v as Record<string, unknown>;
  const ok =
    typeof o === "object" &&
    typeof o.units === "number" &&
    Number.isInteger(o.units) &&
    o.units >= 0 &&
    (o.per === "day" || o.per === "week" || o.per === "month") &&
    typeof o.days === "number" &&
    o.days > 0;
  if (!ok) throw new Error(`features-service served a mostUnits we cannot read for ${where}: ${JSON.stringify(v).slice(0, 200)}`);
  return { units: o.units as number, per: o.per as MostUnits["per"], days: o.days as number };
}

/** `GET /internal/script-strategy?campaignId=&outcome=`: unreadable throws (fail closed). */
export function readStrategyAnswer(campaignId: string, outcome: string): Promise<StrategyAnswer> {
  const key = `${campaignId}|${outcome}`;
  const hit = strategyCache.get(key);
  if (hit && Date.now() - hit.at < STRATEGY_TTL_MS) return hit.answer;
  const answer = (async (): Promise<StrategyAnswer> => {
    const base = (process.env.FEATURES_SERVICE_URL ?? "").replace(/\/$/, "");
    const apiKey = process.env.FEATURES_SERVICE_API_KEY ?? "";
    if (!base || !apiKey) throw new Error("FEATURES_SERVICE_URL and FEATURES_SERVICE_API_KEY must be set to read a campaign's strategy");
    const res = await fetch(`${base}/internal/script-strategy?campaignId=${encodeURIComponent(campaignId)}&outcome=${encodeURIComponent(outcome)}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(600_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`the scripts campaign ${campaignId}'s strategy keeps for ${outcome} could not be read (features-service ${res.status}): ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { keptDynasties?: unknown; mostUnits?: unknown };
    if (!Array.isArray(body.keptDynasties)) throw new Error(`features-service answered no keptDynasties for campaign ${campaignId} x ${outcome}`);
    return { keptDynasties: body.keptDynasties.map(String), mostUnits: parseMostUnits(body.mostUnits, `campaign ${campaignId} x ${outcome}`) };
  })();
  strategyCache.set(key, { at: Date.now(), answer });
  answer.catch(() => strategyCache.delete(key));
  return answer;
}

/** The pace a campaign's brief states on one Engine (null = none). */
export type MostUnitsReader = (campaignId: string, outcome: string) => Promise<MostUnits | null>;
export const productionMostUnits: MostUnitsReader = async (campaignId, outcome) => (await readStrategyAnswer(campaignId, outcome)).mostUnits;

/** How many Units of `outcome` the campaign made since `since` (stops counting at `atLeast`). */
export type CampaignUnitCounter = (input: { orgId: string; campaignId: string; outcome: string; since: Date; atLeast: number }) => Promise<number>;

export const productionCampaignUnits: CampaignUnitCounter = async ({ orgId, campaignId, outcome, since, atLeast }) => {
  const base = (process.env.RUNS_SERVICE_URL ?? "").replace(/\/$/, "");
  const key = process.env.RUNS_SERVICE_API_KEY ?? "";
  if (!base || !key) throw new Error("RUNS_SERVICE_URL and RUNS_SERVICE_API_KEY must be set to count a campaign's Units");
  let count = 0;
  let cursor: string | null = null;
  for (let page = 0; page < 50; page++) {
    const q = new URLSearchParams({ outcomeKey: outcome, orgId, direction: "produced", declaredAfter: since.toISOString(), limit: "1000" });
    if (cursor) q.set("cursor", cursor);
    const res = await fetch(`${base}/internal/outcome-occurrences?${q}`, { headers: { "x-api-key": key }, signal: AbortSignal.timeout(600_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`the Units of ${outcome} campaign ${campaignId} made since ${since.toISOString()} could not be counted (runs-service ${res.status}): ${text.slice(0, 300)}`);
    const body = JSON.parse(text) as { occurrences?: Array<{ quantity?: unknown; reversal?: unknown; tags?: { campaignId?: unknown } }>; nextCursor?: unknown };
    if (!Array.isArray(body.occurrences)) throw new Error(`runs-service answered no occurrences for ${outcome}: ${text.slice(0, 300)}`);
    for (const o of body.occurrences) {
      if (o.reversal) continue;
      if (o.tags?.campaignId !== campaignId) continue;
      const q = Number(o.quantity);
      if (!Number.isFinite(q) || q <= 0) throw new Error(`runs-service served an occurrence of ${outcome} with no quantity we can read: ${JSON.stringify(o).slice(0, 200)}`);
      count += q;
    }
    if (count >= atLeast) return count;
    cursor = typeof body.nextCursor === "string" && body.nextCursor ? body.nextCursor : null;
    if (!cursor) return count;
  }
  throw new Error(`the Units of ${outcome} campaign ${campaignId} span more than 50 pages: not counted`);
};

let mostUnitsReader: MostUnitsReader = productionMostUnits;
let unitCounter: CampaignUnitCounter = productionCampaignUnits;
/** Tests swap the readers (null = production). */
export function setMostUnitsReaders(r: { mostUnits?: MostUnitsReader | null; count?: CampaignUnitCounter | null }): void {
  if ("mostUnits" in r) mostUnitsReader = r.mostUnits ?? productionMostUnits;
  if ("count" in r) unitCounter = r.count ?? productionCampaignUnits;
}

const PERIOD_WORDS: Record<MostUnits["per"], string> = { day: "a day", week: "a week", month: "a month" };

/**
 * Whether the campaign already made the most Units of `outcome` its brief allows in the period: the reason to answer
 * (`most_units_reached: <words>`), else null. No campaign, or no pace stated = null (nothing read past the strategy).
 */
export async function paceHold(input: { campaignId: string | null | undefined; orgId: string | null | undefined; outcome: string; now?: Date }): Promise<string | null> {
  if (process.env.MOST_UNITS_PACE === "off") return null;
  if (!input.campaignId || !input.orgId) return null;
  const pace = await mostUnitsReader(input.campaignId, input.outcome);
  if (!pace) return null;
  const now = input.now ?? new Date();
  const since = new Date(now.getTime() - pace.days * 86_400_000);
  const made = pace.units === 0 ? 0 : await unitCounter({ orgId: input.orgId, campaignId: input.campaignId, outcome: input.outcome, since, atLeast: pace.units });
  if (made < pace.units) return null;
  return `${MOST_UNITS_REACHED}: this campaign's brief allows at most ${pace.units} ${input.outcome} ${PERIOD_WORDS[pace.per]}, and it made ${made} in the last ${pace.days * 24} hours`;
}
