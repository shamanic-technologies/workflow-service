#!/usr/bin/env node
/**
 * Ops script: fork a cold-email dynasty into a variant that reads the lead's own
 * landing page and hands it to the model, so reply rate can be measured against
 * the same DAG without it.
 *
 * The experiment is one arm against another: the control is whatever the dynasty
 * already runs, the treatment is that same DAG plus a scrape of the lead's
 * website, injected into a FORKED prompt template. Everything else is held
 * equal — same nodes, same lead source, same brand fields, same model — so a
 * difference in reply rate is attributable to the landing page and nothing else.
 *
 * Three nodes are spliced in ahead of the content-generation call:
 *
 *   resolve-landing-url  script     websiteUrl ?? primaryDomain ?? the email's
 *                                   own domain. That last fallback is what makes
 *                                   the arm measurable at all: lead-service
 *                                   serves an organization website for only
 *                                   about a fifth of the leads this feature
 *                                   contacts, while 0 of the 49,997 already
 *                                   contacted used a freemail address — so the
 *                                   sender's domain IS the company's, and
 *                                   coverage goes from ~20% to ~100%.
 *   scrape-landing       http.call  scraping POST /scrape with enrich:false.
 *                                   The default enrich:true reruns an LLM
 *                                   extraction of company facts lead-service has
 *                                   already served; raw-fetch mode returns the
 *                                   page body and nothing else, which is the
 *                                   only thing this arm wants.
 *   landing-content      script     decides what the model is given.
 *
 * NOTHING IN THIS CHAIN MAY FAIL THE RUN. A lead whose site is unreachable, a
 * 404, a parking page, a scrape-do outage — all of them mean "no landing page",
 * not "abandon this lead". `scrape-landing` therefore sets `tolerateFailure`, so
 * a non-2xx is returned rather than thrown, and `landing-content` collapses
 * every one of those outcomes to the same explicit sentence for the model. The
 * alternative (fail hard, let the lead fall back into lead-service's retry pool)
 * was considered and dropped for v1: that pool has no attempt cap, so a lead
 * nobody can scrape would cycle forever, reburning a scrape and most of the DAG
 * each time.
 *
 * One consequence to hold in mind: a node that never throws is a node Windmill
 * never retries. The retry that remains is whatever scraping-service does
 * internally, and a transient 502 therefore costs this lead its landing page
 * rather than being retried here.
 *
 * Both the anchor and the lead root are DERIVED from each workflow's own
 * mappings rather than hardcoded — the three heads do not agree on their node
 * sets (lithium carries a `brands-fetch`, ballad a `brand-profile`, azalea
 * neither), and only their content-generation node's own `$ref`s say where this
 * DAG keeps its lead.
 *
 * The forked template must EXIST in content-generation before a fork runs: the
 * new `body.type` is `<current>-landing`, and content-generation 404s a type it
 * has never stored. Create the three forked prompts first (POST
 * /platform-prompts, copy of the current body plus the landing-page block ending
 * in `{{landingPageContent}}`), then run this.
 *
 * Idempotent: a DAG that already exists as an active workflow collides on
 * signature and `PUT /workflows/:id` answers 409, recorded as already covered.
 * A dynasty whose head already carries the chain is skipped before any write.
 * The dry run walks the same code path as the real one.
 *
 * Usage, from inside the workflow-service container:
 *
 *   node fork-dynasty-with-landing-page.mjs --org <uuid>
 *   node fork-dynasty-with-landing-page.mjs --org <uuid> --apply
 *   node fork-dynasty-with-landing-page.mjs --org <uuid> --dynasties a,b --apply
 *
 * `--org` is the identity the READS are made under. Each fork is then written
 * under the SOURCE workflow's own `orgId`, read off `GET /workflows/{id}` —
 * a fork takes its org from the caller's `x-org-id`, and these three dynasties
 * do not all belong to the same org, so a single org for the writes would land
 * one of the variants under the wrong scope.
 *
 * Env: WORKFLOW_SERVICE_API_KEY (required), BASE_URL (default localhost:8080).
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:8080";
const API_KEY = process.env.WORKFLOW_SERVICE_API_KEY;
const APPLY = process.argv.includes("--apply");

export const FEATURE_SLUG = "sales-cold-email-outreach";

/** The three dynasties with enough volume for the arm to ever be readable. */
export const DEFAULT_DYNASTIES = [
  "sales-cold-email-outreach-lithium",
  "sales-cold-email-outreach-azalea",
  "sales-cold-email-outreach-ballad",
];

/** Suffix appended to the prompt template the source workflow renders. */
export const TEMPLATE_SUFFIX = "-landing";

/** Variable the forked template reads. */
export const LANDING_VARIABLE = "landingPageContent";

/**
 * What the model is told when there is no usable page. It is a sentence rather
 * than an empty string because content-generation's renderer substitutes
 * `{{name}}` tokens and nothing else — it has no conditional sections — so the
 * template's "below is the lead's landing page" heading is printed either way.
 * An empty value under that heading reads to the model as a page that was blank;
 * this says plainly that there was none.
 */
export const NO_LANDING_PAGE =
  "No landing page could be retrieved for this lead. Write the email without it.";

/** Below this, a scrape result is a parking page or a placeholder, not content. */
export const MIN_USABLE_CHARS = 500;

/**
 * Upper bound on what reaches the prompt. Measured over 95,777 scrapes: p95 is
 * 79k chars and p97 157k, so this passes ~96% of pages whole — which is the
 * point, a long-but-normal landing page belongs in the prompt in full. What it
 * cuts is the class that is not a landing page at all (the longest observed
 * result was 1,253k chars, a ~$3.75 prompt on a lead that costs $0.18 today).
 */
export const MAX_CONTENT_CHARS = 100_000;

export const RESOLVE_URL_CODE = `export async function main(websiteUrl, primaryDomain, email) {
  const clean = (v) => (typeof v === "string" ? v.trim() : "");

  let candidate = clean(websiteUrl) || clean(primaryDomain);
  if (!candidate) {
    const address = clean(email);
    const at = address.lastIndexOf("@");
    if (at !== -1) candidate = address.slice(at + 1);
  }
  if (!candidate) {
    console.error("no website, domain or email to derive a landing page from");
    return { url: "" };
  }

  const withScheme = /^https?:\\/\\//i.test(candidate)
    ? candidate
    : "https://" + candidate.replace(/^\\/+/, "");

  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname.includes(".")) {
      console.error("derived host is not a domain: " + parsed.hostname);
      return { url: "" };
    }
    return { url: parsed.toString() };
  } catch {
    console.error("could not derive a URL from: " + candidate);
    return { url: "" };
  }
}`;

export const LANDING_CONTENT_CODE = `export async function main(rawMarkdown) {
  const NO_LANDING_PAGE = ${JSON.stringify(NO_LANDING_PAGE)};
  const MIN_USABLE_CHARS = ${MIN_USABLE_CHARS};
  const MAX_CONTENT_CHARS = ${MAX_CONTENT_CHARS};

  const text = typeof rawMarkdown === "string" ? rawMarkdown.trim() : "";

  if (text.length < MIN_USABLE_CHARS) {
    console.error(
      "landing page unusable (" + text.length + " chars) — generating without it",
    );
    return { value: NO_LANDING_PAGE };
  }

  if (text.length > MAX_CONTENT_CHARS) {
    console.error(
      "landing page capped from " + text.length + " to " + MAX_CONTENT_CHARS + " chars",
    );
    return { value: text.slice(0, MAX_CONTENT_CHARS) };
  }

  return { value: text };
}`;

/**
 * The content-generation call is the only node in these DAGs that posts to
 * `/generate`. Locating it by path rather than by node id keeps this working
 * across DAGs, which do not agree on node naming.
 */
export function findGenerateNode(dag) {
  return dag.nodes.find((n) => n.config?.path === "/generate" && n.config?.body?.type);
}

/**
 * Where this DAG keeps the lead, read off the generate node's own mappings.
 * `body.variables.leadCompanyWebsiteUrl` is the anchor: every head maps it, and
 * the segment before `.data.organization.` is the lead root regardless of how
 * the fetching node is named or how deeply it nests its result.
 */
export function deriveLeadRoot(generateNode) {
  for (const ref of Object.values(generateNode.inputMapping ?? {})) {
    if (typeof ref !== "string" || !ref.startsWith("$ref:")) continue;
    const match = ref.slice("$ref:".length).match(/^(.+?)\.data\.organization\./);
    if (match) return match[1];
  }
  return null;
}

/**
 * The node whose edge into the generate call is spliced. Derived, again, from
 * the generate node's own wiring: whatever produces `brandExtractedFields` runs
 * immediately before it in all three heads, while the other predecessors differ
 * per dynasty.
 */
export function deriveAnchor(generateNode) {
  const ref = generateNode.inputMapping?.["body.variables.brandExtractedFields"];
  if (typeof ref !== "string" || !ref.startsWith("$ref:")) return null;
  return ref.slice("$ref:".length).split(".")[0];
}

/** True when this DAG already carries the chain, so a fork would be a no-op. */
export function hasLandingPage(dag) {
  return dag.nodes.some((n) => n.id === "scrape-landing");
}

/**
 * Returns a copy of `dag` with the landing-page chain spliced in ahead of the
 * content-generation call, and that call repointed at the forked template.
 * Throws rather than guessing whenever the DAG does not state what it needs.
 */
export function withLandingPage(dag) {
  const clone = structuredClone(dag);

  const generate = findGenerateNode(clone);
  if (!generate) throw new Error("no content-generation /generate node in DAG");
  if (hasLandingPage(clone)) throw new Error("DAG already carries the landing-page chain");

  const leadRoot = deriveLeadRoot(generate);
  if (!leadRoot) {
    throw new Error(
      `node "${generate.id}" states no lead organization $ref, so the lead root cannot be derived`,
    );
  }

  const anchor = deriveAnchor(generate);
  if (!anchor) {
    throw new Error(
      `node "${generate.id}" maps no brandExtractedFields, so the splice point cannot be derived`,
    );
  }

  const anchorEdge = clone.edges.find((e) => e.from === anchor && e.to === generate.id);
  if (!anchorEdge) {
    throw new Error(`no edge "${anchor}" -> "${generate.id}" to splice the chain into`);
  }

  clone.nodes.push(
    {
      id: "resolve-landing-url",
      type: "script",
      config: { code: RESOLVE_URL_CODE },
      retries: 0,
      inputMapping: {
        websiteUrl: `$ref:${leadRoot}.data.organization.websiteUrl`,
        primaryDomain: `$ref:${leadRoot}.data.organization.primaryDomain`,
        email: `$ref:${leadRoot}.email`,
      },
    },
    {
      id: "scrape-landing",
      type: "http.call",
      config: {
        service: "scraping",
        method: "POST",
        path: "/scrape",
        // A page we cannot read is an outcome, not an error. See the header.
        tolerateFailure: true,
        body: { enrich: false, sourceService: "workflow-service" },
      },
      retries: 0,
      inputMapping: {
        "body.url": "$ref:resolve-landing-url.output.url",
        "body.sourceRefId": `$ref:${leadRoot}.leadId`,
      },
    },
    {
      id: "landing-content",
      type: "script",
      config: { code: LANDING_CONTENT_CODE },
      retries: 0,
      inputMapping: {
        rawMarkdown: "$ref:scrape-landing.output.result.rawMarkdown",
      },
    },
  );

  anchorEdge.to = "resolve-landing-url";
  clone.edges.push(
    { from: "resolve-landing-url", to: "scrape-landing" },
    { from: "scrape-landing", to: "landing-content" },
    { from: "landing-content", to: generate.id },
  );

  generate.config.body.type = `${generate.config.body.type}${TEMPLATE_SUFFIX}`;
  generate.inputMapping = {
    ...generate.inputMapping,
    [`body.variables.${LANDING_VARIABLE}`]: "$ref:landing-content.output.value",
  };

  return clone;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function headers(orgId) {
  return {
    "content-type": "application/json",
    "x-api-key": API_KEY,
    "x-org-id": orgId,
    "x-user-id": randomUUID(),
    "x-run-id": randomUUID(),
  };
}

async function call(orgId, method, path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(orgId),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  return { status: res.status, payload };
}

/** Resolve each dynasty's currently-active version. Exactly one exists, or none. */
async function resolveHeads(readOrg, dynasties) {
  const listed = await call(
    readOrg,
    "GET",
    `/public/workflows?featureSlugs=${FEATURE_SLUG}&status=active`,
  );
  if (listed.status !== 200) {
    throw new Error(`public list failed ${listed.status} ${JSON.stringify(listed.payload)}`);
  }
  const all = listed.payload.workflows ?? [];
  return dynasties.map((slug) => {
    const heads = all.filter((w) => w.workflowDynastySlug === slug);
    if (heads.length === 0) {
      return { slug, error: `no active version — the dynasty is parked or retired` };
    }
    if (heads.length > 1) {
      return { slug, error: `reports ${heads.length} active versions` };
    }
    return { slug, head: heads[0] };
  });
}

async function main() {
  if (!API_KEY) {
    console.error("WORKFLOW_SERVICE_API_KEY is required");
    process.exit(1);
  }
  const readOrg = arg("org");
  if (!readOrg) {
    console.error("usage: --org <uuid> [--dynasties a,b] [--apply]");
    process.exit(1);
  }
  const dynasties = (arg("dynasties") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const targets = dynasties.length > 0 ? dynasties : DEFAULT_DYNASTIES;

  const resolved = await resolveHeads(readOrg, targets);
  const results = [];

  for (const entry of resolved) {
    if (entry.error) {
      results.push({ slug: entry.slug, outcome: `FAILED ${entry.error}` });
      continue;
    }

    const got = await call(readOrg, "GET", `/workflows/${entry.head.id}`);
    if (got.status !== 200) {
      results.push({
        slug: entry.slug,
        outcome: `FAILED GET workflow ${got.status} ${JSON.stringify(got.payload)}`,
      });
      continue;
    }

    const source = got.payload;
    if (hasLandingPage(source.dag)) {
      results.push({ slug: entry.slug, outcome: `skipped — ${source.workflowSlug} already reads a landing page` });
      continue;
    }

    let forked;
    try {
      forked = withLandingPage(source.dag);
    } catch (err) {
      results.push({ slug: entry.slug, outcome: `FAILED ${err.message}` });
      continue;
    }

    const template = findGenerateNode(forked).config.body.type;
    if (!APPLY) {
      results.push({
        slug: entry.slug,
        outcome: `would fork ${source.workflowSlug} (org ${source.orgId}) onto template ${template}`,
      });
      continue;
    }

    // The fork is written under the SOURCE workflow's org, not the read org.
    const put = await call(source.orgId, "PUT", `/workflows/${entry.head.id}`, { dag: forked });
    if (put.status === 201) {
      results.push({ slug: entry.slug, outcome: `created ${put.payload.workflowSlug} (template ${template})` });
    } else if (put.status === 409) {
      results.push({ slug: entry.slug, outcome: `already covered by ${put.payload.existingWorkflowSlug}` });
    } else {
      results.push({ slug: entry.slug, outcome: `FAILED ${put.status} ${JSON.stringify(put.payload)}` });
    }
  }

  console.log(APPLY ? "=== APPLY ===" : "=== DRY RUN (no writes) ===");
  for (const r of results) console.log(`${r.slug} | ${r.outcome}`);

  const failed = results.filter((r) => String(r.outcome).startsWith("FAILED"));
  console.log(`\n${results.length} dynasties, ${failed.length} failed`);
  if (failed.length > 0) process.exitCode = 1;
}

// Importable by the test suite; only runs when executed directly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
