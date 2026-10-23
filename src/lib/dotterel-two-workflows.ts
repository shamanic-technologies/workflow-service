/**
 * DOTTEREL-TWO-WORKFLOWS-1023 (owner 2026-10-23: « On veut qu'un seul non ? », then « Oui laisse Keel à côté. Go »).
 * The Cold Email "Lead found -> Positive reply" pipe (`sales-cold-email-outreach|lead_found_to_conversation`) runs
 * TWO workflows, Ballad and Keel. The eight that ran there differed by copy drift, not by a tested hypothesis
 * (a missing `currentDate`, the whole extract-fields envelope instead of its `fields`, keywords read off
 * `organization.industries`, no send timezone), so:
 * - Ballad and Keel are each UPGRADED in their own dynasty (never a fork) with the full writer brief below;
 * - the six others are MERGED into Ballad (`POST /workflows/dynasty/{slug}/merge`: deprecated on both axes with
 *   Ballad as successor, a held slug forwards to Ballad, history untouched, reversible).
 * Keel's ONE difference from Ballad stays the brand's website link (`clientWebsite`). Applied by
 * `scripts/dotterel-two-workflows-1023.mjs`.
 */
import type { DAG } from "./dag-validator.js";

export const DOTTEREL_FEATURE_SLUG = "sales-cold-email-outreach";
export const DOTTEREL_LEG = "lead_found_to_conversation";
const P = `${DOTTEREL_FEATURE_SLUG}-`;
export const DOTTEREL_SURVIVOR = `${P}ballad`;
export const DOTTEREL_CHALLENGER = `${P}keel`;
export const DOTTEREL_KEPT = [DOTTEREL_SURVIVOR, DOTTEREL_CHALLENGER] as const;
export const DOTTEREL_ABSORBED = ["tectonic", "acrux", "alkarab", "cerulean", "ainalrami", "fuyue"].map((s) => P + s);
export const DOTTEREL_MERGE_REASON = "copy drift, superseded by Ballad (owner 2026-10-23)";

/** The brief every kept workflow's writer gets, beyond what Ballad already mapped. */
export const FULL_BRIEF_MAPPINGS: Record<string, string> = {
  "body.variables.currentDate": "$ref:flow_input.currentDate",
  "body.variables.brandExtractedFields": "$ref:brand-extract-fields.output.fields",
  "body.variables.leadCompanyKeywords": "$ref:fetch-lead.output.lead.data.organization.keywords",
};
export const SEND_TIMEZONE_KEY = "body.timezone";
export const SEND_TIMEZONE_REF = "$ref:fetch-lead.output.lead.data.timezone";

export const DOTTEREL_DESCRIPTIONS: Record<(typeof DOTTEREL_KEPT)[number], string> = {
  [DOTTEREL_SURVIVOR]:
    "Looks up the brand's name and gives it to the writer with today's date, the brand's own facts, the full lead profile and the company's keywords. Sends are timed to the lead's timezone.",
  [DOTTEREL_CHALLENGER]:
    "Looks up the brand's name and website link and gives both to the writer with today's date, the brand's own facts, the full lead profile and the company's keywords. Sends are timed to the lead's timezone.",
};

type Node = DAG["nodes"][number];
const pathOf = (n: Node) => (n.config as { path?: string } | undefined)?.path;
const only = (dag: DAG, path: string, what: string): Node => {
  const found = dag.nodes.filter((n) => n.type === "http.call" && pathOf(n) === path);
  if (found.length !== 1) throw new Error(`expected exactly one ${what} (${path}), found ${found.length}`);
  return found[0];
};

/**
 * PURE: `dag` with the full writer brief on its single `/generate` call and the lead's timezone on its single
 * `/orgs/send` (the source is never mutated). Throws when the call builds its whole body or variables from a
 * mapping, or when a node the brief reads is absent: never a guessed DAG.
 */
export function withFullWriterBrief(dag: DAG): DAG {
  const clone = structuredClone(dag);
  const gen = only(clone, "/generate", "content generation call");
  const send = only(clone, "/orgs/send", "email send");
  const ids = new Set(clone.nodes.map((n) => n.id));
  for (const need of ["brand-extract-fields", "fetch-lead"]) {
    if (!ids.has(need)) throw new Error(`node ${need} is absent: the brief cannot read it`);
  }
  const im = { ...(gen.inputMapping ?? {}) };
  if ("body" in im || "body.variables" in im) throw new Error(`${gen.id} maps its whole body: refusing to guess`);
  Object.assign(im, FULL_BRIEF_MAPPINGS);
  gen.inputMapping = im;
  send.inputMapping = { ...(send.inputMapping ?? {}), [SEND_TIMEZONE_KEY]: SEND_TIMEZONE_REF };
  return clone;
}

/** PURE: the generate-call input keys whose mapping differs between two DAGs, as `key: a -> b`. */
export function generateInputDiff(a: DAG, b: DAG): string[] {
  const ma = only(a, "/generate", "content generation call").inputMapping ?? {};
  const mb = only(b, "/generate", "content generation call").inputMapping ?? {};
  return [...new Set([...Object.keys(ma), ...Object.keys(mb)])]
    .sort()
    .filter((k) => ma[k] !== mb[k])
    .map((k) => `${k}: ${ma[k] ?? "(none)"} -> ${mb[k] ?? "(none)"}`);
}
