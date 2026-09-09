import type { DAG } from "./dag-validator.js";
import { getResponseSchema, walkSchemaPath } from "./openapi-schema-resolver.js";
import type { ResolvedSchema } from "./openapi-schema-resolver.js";

/**
 * Additive mapping of content-generation's OPTIONAL context variables onto the
 * lead facts lead-service actually serves.
 *
 * content-generation publishes a second, separate list on every prompt read:
 * `variables` are the tokens the stored template body declares, while
 * `contextVariables` are optional inputs rendered into a "Recipient context"
 * block ahead of the template. A caller that sends none of them gets the prompt
 * it got before that existed, byte for byte — which is why every active email
 * workflow silently shipped a prompt carrying five lead facts when the producer
 * had been serving thirty-three.
 *
 * The list is read LIVE from content-generation (a name it stops publishing
 * stops being mapped, and a name it adds is mapped the next time this runs).
 * The PATH each name resolves to is the only thing stated here, and every one
 * is checked against lead-service's live response schema before it is written:
 * a name the served shape cannot satisfy is REPORTED, never guessed at. That is
 * the same gate as `lead-context-mapping.ts`, pointed the other way — that
 * module repairs refs that exist and are wrong, this one adds refs that are
 * missing.
 *
 * Two shapes are deliberately mapped straight through rather than reshaped by a
 * `script` node: `employmentHistory` and `fundingEvents` are arrays of objects
 * whose keys differ from the illustrative ones in content-generation's
 * descriptions (`organizationName`/`startDate` rather than `company`/`start`).
 * Its renderer walks whatever keys an object carries and humanises them, so the
 * served entries read correctly as-is; a mapping node per DAG would buy nothing
 * and would change the topology of thirty-one live workflows.
 */

/**
 * Every context variable this repo knows how to satisfy, as a path UNDER the
 * canonical lead object (lead-service's FullLead). The root itself is never
 * assumed — it is derived per DAG from that workflow's own existing mappings.
 */
export const LEAD_CONTEXT_PATHS: Readonly<Record<string, string>> = {
  // Person
  leadFirstName: "firstName",
  leadLastName: "lastName",
  leadTitle: "currentTitle",
  leadHeadline: "headline",
  leadSeniority: "seniority",
  leadDepartments: "departments",
  leadFunctions: "functions",
  leadCity: "city",
  leadState: "state",
  leadCountry: "country",
  leadTimezone: "timezone",
  leadBusinessLanguages: "businessLanguages",
  leadLinkedinUrl: "linkedinUrl",
  leadEmploymentHistory: "employmentHistory",
  // Organization — the employer is nested, never flattened onto the lead.
  leadCompanyName: "organization.name",
  leadCompanyDescription: "organization.shortDescription",
  leadCompanySeoDescription: "organization.seoDescription",
  leadCompanyIndustry: "organization.industry",
  leadCompanyIndustries: "organization.industries",
  leadCompanySecondaryIndustries: "organization.secondaryIndustries",
  leadCompanyKeywords: "organization.keywords",
  leadCompanyTechStack: "organization.technologyNames",
  leadCompanySize: "organization.estimatedNumEmployees",
  leadCompanyFoundedYear: "organization.foundedYear",
  leadCompanyAnnualRevenue: "organization.annualRevenue",
  leadCompanyFundingStage: "organization.latestFundingStage",
  leadCompanyTotalFunding: "organization.totalFunding",
  leadCompanyFundingEvents: "organization.fundingEvents",
  leadCompanyWebsiteUrl: "organization.websiteUrl",
  leadCompanyLinkedinUrl: "organization.linkedinUrl",
  leadCompanyCity: "organization.city",
  leadCompanyState: "organization.state",
  leadCompanyCountry: "organization.country",
};

/**
 * Probe fields that identify the canonical lead object among the prefixes of a
 * DAG's existing refs. Both live directly on FullLead, so a prefix that
 * resolves them both is the root and `lead` / `lead.data.organization` are not.
 */
const ROOT_PROBE = ["firstName", "currentTitle"];

export interface LeadContextAddition {
  /** The content-generation node the mapping is added to. */
  nodeId: string;
  /** The context variable name, as published by content-generation. */
  variable: string;
  /** The inputMapping key written, e.g. `body.variables.leadSeniority`. */
  key: string;
  ref: string;
}

export interface LeadContextSkip {
  nodeId: string;
  variable: string;
  reason: "unknown-name" | "path-does-not-resolve" | "no-lead-root";
  /** The path tried, when there was one. */
  tried?: string;
}

export interface LeadContextVariablesPlan {
  additions: LeadContextAddition[];
  skipped: LeadContextSkip[];
}

interface LeadRootRef {
  /** Producing node id as spelled in this DAG's refs. */
  producerId: string;
  /** Path segments from the producer's response down to the canonical lead. */
  root: string[];
}

/** Parses `$ref:<node-id>[.output].<a>.<b>…` into its producer and path. */
function parseRef(ref: unknown): { producerId: string; path: string[] } | null {
  if (typeof ref !== "string" || !ref.startsWith("$ref:")) return null;
  const parts = ref.slice("$ref:".length).split(".");
  const producerId = parts[0];
  if (!producerId || producerId === "flow_input") return null;
  const path = parts.slice(1).filter((p) => p !== "output");
  if (path.length === 0) return null;
  return { producerId, path };
}

/** Node ids are written with hyphens or underscores depending on the DAG. */
function matchesNode(nodeId: string, producerId: string): boolean {
  return producerId === nodeId || producerId === nodeId.replace(/-/g, "_");
}

/**
 * Finds where the canonical lead sits in this node's existing mappings.
 *
 * The root is never assumed: it is taken from a ref the DAG ALREADY carries and
 * kept only if the producer's live response schema resolves the probe fields
 * under it. A node with no usable lead ref yields null and is reported — this
 * repo does not invent a path into a producer it cannot see the caller using.
 */
function findLeadRoot(
  inputMapping: Record<string, string>,
  leadNodeIds: string[],
  resolves: (path: string[]) => boolean,
): LeadRootRef | null {
  const candidates: LeadRootRef[] = [];

  for (const ref of Object.values(inputMapping)) {
    const parsed = parseRef(ref);
    if (!parsed) continue;
    if (!leadNodeIds.some((id) => matchesNode(id, parsed.producerId))) continue;
    // Every ancestor of the ref's path, longest first — `lead.data` beats `lead`.
    for (let len = parsed.path.length; len >= 1; len--) {
      candidates.push({ producerId: parsed.producerId, root: parsed.path.slice(0, len) });
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const fingerprint = `${candidate.producerId}:${candidate.root.join(".")}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    if (ROOT_PROBE.every((field) => resolves([...candidate.root, field]))) return candidate;
  }

  return null;
}

/**
 * Decides which context variables a DAG's content-generation nodes are missing
 * and what `$ref` each one should carry. Pure; makes no changes.
 *
 * Nothing already mapped is touched — a `body.variables.<name>` key present in
 * the node is left exactly as it is, whatever it points at. A DAG whose
 * lead-service spec is absent from `specs` yields an empty plan: without the
 * served shape there is nothing to judge a path against.
 */
export function planLeadContextVariables(
  dag: DAG,
  specs: Map<string, Record<string, unknown>>,
  contextVariables: string[],
): LeadContextVariablesPlan {
  const additions: LeadContextAddition[] = [];
  const skipped: LeadContextSkip[] = [];

  const spec = specs.get("lead");
  if (!spec) return { additions, skipped };

  const leadNodes = dag.nodes.filter(
    (n) =>
      n.type === "http.call" &&
      n.config?.service === "lead" &&
      typeof n.config?.path === "string" &&
      typeof n.config?.method === "string",
  );
  if (leadNodes.length === 0) return { additions, skipped };

  const generateNodes = dag.nodes.filter(
    (n) =>
      n.type === "http.call" &&
      n.config?.service === "content-generation" &&
      n.config?.path === "/generate",
  );
  if (generateNodes.length === 0) return { additions, skipped };

  // One producer per DAG in practice; merging their schemas would make a ref
  // resolvable against a node it does not come from, so each is judged alone.
  const responses = leadNodes
    .map((n) => ({
      id: n.id,
      schema: getResponseSchema(spec, n.config!.path as string, n.config!.method as string),
    }))
    .filter((r): r is { id: string; schema: ResolvedSchema } => r.schema !== null);
  if (responses.length === 0) return { additions, skipped };

  for (const node of generateNodes) {
    const inputMapping = node.inputMapping ?? {};

    let root: LeadRootRef | null = null;
    let resolves: ((path: string[]) => boolean) | null = null;
    for (const response of responses) {
      const check = (path: string[]) => walkSchemaPath(response.schema, path, spec).valid;
      const found = findLeadRoot(inputMapping, [response.id], check);
      if (found) {
        root = found;
        resolves = check;
        break;
      }
    }

    if (!root || !resolves) {
      for (const variable of contextVariables) {
        skipped.push({ nodeId: node.id, variable, reason: "no-lead-root" });
      }
      continue;
    }

    for (const variable of contextVariables) {
      const key = `body.variables.${variable}`;
      if (key in inputMapping) continue;

      const relative = LEAD_CONTEXT_PATHS[variable];
      if (!relative) {
        skipped.push({ nodeId: node.id, variable, reason: "unknown-name" });
        continue;
      }

      const path = [...root.root, ...relative.split(".")];
      if (!resolves(path)) {
        skipped.push({
          nodeId: node.id,
          variable,
          reason: "path-does-not-resolve",
          tried: path.join("."),
        });
        continue;
      }

      additions.push({
        nodeId: node.id,
        variable,
        key,
        ref: `$ref:${root.producerId}.output.${path.join(".")}`,
      });
    }
  }

  return { additions, skipped };
}

/**
 * Returns a copy of the DAG carrying every mappable context variable.
 * Idempotent: a DAG that already maps them all yields the same object and an
 * empty plan. Only `body.variables.*` keys are added — nothing existing is
 * rewritten, and the prompt type, the model and every other mapping are
 * untouched.
 */
export function applyLeadContextVariables(
  dag: DAG,
  specs: Map<string, Record<string, unknown>>,
  contextVariables: string[],
): { dag: DAG; plan: LeadContextVariablesPlan; changed: boolean } {
  const plan = planLeadContextVariables(dag, specs, contextVariables);
  if (plan.additions.length === 0) return { dag, plan, changed: false };

  const next = structuredClone(dag);
  for (const addition of plan.additions) {
    const node = next.nodes.find((n) => n.id === addition.nodeId);
    if (!node) continue;
    node.inputMapping = { ...(node.inputMapping ?? {}), [addition.key]: addition.ref };
  }

  return { dag: next, plan, changed: true };
}
