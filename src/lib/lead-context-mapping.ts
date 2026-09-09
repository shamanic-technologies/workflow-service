import type { DAG } from "./dag-validator.js";
import { getResponseSchema, walkSchemaPath } from "./openapi-schema-resolver.js";

/**
 * Repair for `$ref` paths into a lead-service response that name a field the
 * served shape does not have.
 *
 * lead-service serves the canonical lead under `lead.data` (FullLead), and the
 * organization under `lead.data.organization`. Seven LLM-authored workflows
 * instead reference a FLAT shape — `lead.data.organizationName`,
 * `lead.data.organizationIndustry`, `lead.data.title` — which no longer exists.
 * Nothing errors: a `$ref` to a missing path renders as an empty string, so the
 * prompt simply reads `Company: ` for months.
 *
 * The rewrite is never assumed. Each broken leaf proposes candidates and the
 * FIRST candidate that RESOLVES against the producer's live response schema is
 * taken; a leaf no candidate resolves is left alone and reported, because a
 * `$ref` the fetch node never returns is worse than the gap it replaces.
 */

/** Leaves whose correct path is not derivable by decapitalisation alone. */
const EXPLICIT_ALIASES: Record<string, string[]> = {
  // The person's job title lives on the lead, not the organization.
  title: ["currentTitle"],
  // Apollo's head count is `estimatedNumEmployees`; there is no `organization.size`.
  organizationSize: ["organization.estimatedNumEmployees"],
};

export interface LeadRefRewrite {
  nodeId: string;
  /** The inputMapping key carrying the ref, e.g. `body.variables.leadCompanyName`. */
  key: string;
  from: string;
  to: string;
}

export interface LeadRefUnresolved {
  nodeId: string;
  key: string;
  ref: string;
  /** Everything tried, so a report says what the served shape would have had to carry. */
  tried: string[];
}

export interface LeadContextPlan {
  rewrites: LeadRefRewrite[];
  unresolved: LeadRefUnresolved[];
}

interface ParsedRef {
  /** Producing node id as written in the ref. */
  producerId: string;
  /** Path segments after the optional `output` marker. */
  path: string[];
}

/** Parses `$ref:<node-id>[.output].<a>.<b>…`. */
function parseRef(ref: unknown): ParsedRef | null {
  if (typeof ref !== "string" || !ref.startsWith("$ref:")) return null;
  const parts = ref.slice("$ref:".length).split(".");
  const producerId = parts[0];
  if (!producerId || producerId === "flow_input") return null;
  const path = parts.slice(1).filter((p) => p !== "output");
  if (path.length === 0) return null;
  return { producerId, path };
}

/**
 * The candidate paths for a leaf, most specific first. `organizationFooBar`
 * becomes `organization.fooBar`; anything else has only its explicit aliases.
 */
function candidatesFor(leaf: string): string[] {
  const explicit = EXPLICIT_ALIASES[leaf] ?? [];
  const nested = /^organization([A-Z].*)$/.exec(leaf);
  if (!nested) return explicit;
  const field = nested[1][0].toLowerCase() + nested[1].slice(1);
  return [...explicit, `organization.${field}`];
}

/** Node ids are written with hyphens or underscores depending on the DAG. */
function matchesNode(nodeId: string, producerId: string): boolean {
  return producerId === nodeId || producerId === nodeId.replace(/-/g, "_");
}

/**
 * Decides, for every `$ref` into a lead-service node, whether its path resolves
 * against that endpoint's live response schema and — when it does not — which
 * repaired path does. Pure; makes no changes.
 *
 * A DAG whose lead-service spec is absent from `specs` yields an empty plan:
 * without the served shape there is nothing to judge a rewrite against, and
 * guessing is the failure this function exists to prevent.
 */
export function planLeadContextMapping(
  dag: DAG,
  specs: Map<string, Record<string, unknown>>,
): LeadContextPlan {
  const rewrites: LeadRefRewrite[] = [];
  const unresolved: LeadRefUnresolved[] = [];

  const producers = dag.nodes.filter(
    (n) =>
      n.type === "http.call" &&
      n.config?.service === "lead" &&
      typeof n.config?.path === "string" &&
      typeof n.config?.method === "string",
  );

  for (const producer of producers) {
    const spec = specs.get("lead");
    if (!spec) continue;

    const response = getResponseSchema(
      spec,
      producer.config!.path as string,
      producer.config!.method as string,
    );
    if (!response) continue;

    const resolves = (path: string[]): boolean =>
      walkSchemaPath(response, path, spec).valid;

    for (const node of dag.nodes) {
      for (const [key, ref] of Object.entries(node.inputMapping ?? {})) {
        const parsed = parseRef(ref);
        if (!parsed || !matchesNode(producer.id, parsed.producerId)) continue;
        if (resolves(parsed.path)) continue;

        const leaf = parsed.path[parsed.path.length - 1];
        const prefix = parsed.path.slice(0, -1);
        const tried: string[] = [];
        let rewritten: string | null = null;

        for (const candidate of candidatesFor(leaf)) {
          const path = [...prefix, ...candidate.split(".")];
          tried.push(path.join("."));
          if (resolves(path)) {
            rewritten = `$ref:${parsed.producerId}.output.${path.join(".")}`;
            break;
          }
        }

        if (rewritten) {
          rewrites.push({ nodeId: node.id, key, from: ref, to: rewritten });
        } else {
          unresolved.push({ nodeId: node.id, key, ref, tried });
        }
      }
    }
  }

  return { rewrites, unresolved };
}

/**
 * Returns a copy of the DAG with every repairable lead `$ref` rewritten.
 * Idempotent: a DAG whose refs all resolve yields the same object and an empty
 * plan. Nothing but the rewritten refs changes — the prompt type, the model and
 * every other mapping are untouched.
 */
export function applyLeadContextMapping(
  dag: DAG,
  specs: Map<string, Record<string, unknown>>,
): { dag: DAG; plan: LeadContextPlan; changed: boolean } {
  const plan = planLeadContextMapping(dag, specs);
  if (plan.rewrites.length === 0) return { dag, plan, changed: false };

  const next = structuredClone(dag);
  for (const rewrite of plan.rewrites) {
    const node = next.nodes.find((n) => n.id === rewrite.nodeId);
    if (!node?.inputMapping) continue;
    node.inputMapping[rewrite.key] = rewrite.to;
  }

  return { dag: next, plan, changed: true };
}
