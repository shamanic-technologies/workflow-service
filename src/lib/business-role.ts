/**
 * AN AI LINE CAN ANSWER AS THE BUSINESS OF THE LEAD WHO WRITES (MERCHANT-DEMO-LINE-1103). Owner Kevin, 2026-11-03: a
 * brand (Agent Base) sells local merchants a WhatsApp AI that answers their customers. Its cold script hands a
 * prospected merchant a demo number: « Ask it a question like a customer would. » When that merchant writes, the AI
 * must answer AS THE MERCHANT'S assistant, from the merchant's own site read live, so the merchant sees their own AI
 * working.
 *
 * Whether a line plays that role is DATA the brand states: the persona of the answering line (crm-service, stated on
 * the linked account: name, role, instructions; `sender-persona.ts`). Never a branch on a brand, a slug or a number.
 * The steps, every one skip-gated, run only on a WhatsApp answer whose sending line states instructions:
 *  1. `business-role-plan`: the lead's company domain, read off what we already hold (crm-service's Unibox person
 *     `organizations[].domain`, lead-service's relationship `company.domain`, the lead's own organization). No domain =
 *     nothing asked, nothing read.
 *  2. `business-role-judge`: Jev (`noul`) reads the line's instructions once: do they ask to answer as the business of
 *     the person writing? A cheap input-only judgment, never a keyword rule.
 *  3. `business-site-plan` -> `business-site-read`: only on a yes, scraping-service reads that business's home page
 *     (raw text, no enrichment): the paid read sits at the latest point, right before the writer.
 *  4. `business-role`: the writer's block. An unreadable site is said, never a blank: the writer then hands over what
 *     it cannot answer.
 * No instructions, no domain or a no = the writer's prompt byte for byte as before.
 */
import type { DAGNode } from "./dag-validator.js";

/** Jev's question on the answering line's own instructions. */
export const BUSINESS_ROLE_QUESTION =
  "Do these instructions of an AI assistant's WhatsApp line ask it to answer AS the business of the person writing to it (that person's own company), rather than as the company that owns the line?";

export const BUSINESS_ROLE_CRITERIA = {
  true: "The instructions say the assistant speaks for, plays or demonstrates the writer's own business (their shop, restaurant, company), answering as that business's assistant would.",
  false: "The instructions only describe the line owner's own assistant, its tone or its rules, or never mention the writer's business.",
};

/** At or above this probability the line plays the writer's business. */
export const BUSINESS_ROLE_THRESHOLD = 0.5;

/** The most of the business's page the writer is given (raw text, characters). */
export const BUSINESS_SITE_MAX_CHARS = 20_000;

/** The scraping-service feature the read is billed under (the follow-up channel's slug). */
const SCRAPE_FEATURE_SLUG = "ai-follow-up-email";

/**
 * `main(channel, timeline, relationship, person)`: whether to ask Jev at all, and the business's domain. Asks only on
 * a WhatsApp answer whose sending line states instructions and when the lead's domain is known.
 */
export const BUSINESS_ROLE_PLAN_CODE = `
export async function main(channel, timeline, relationship, person) {
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  const none = { skip: true, questions: {}, state: {} };
  if (channel?.skipModel === true || channel?.channel !== "whatsapp") return none;
  const instructions = s(channel?.persona?.instructions);
  if (!instructions) return none;
  const bare = (v) => {
    const t = s(v);
    if (!t) return null;
    const d = t.toLowerCase().replace(/^https?:\\/\\//, "").replace(/^www\\./, "").replace(/[\\/?#].*$/, "");
    return /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/.test(d) ? d : null;
  };
  const orgs = Array.isArray(timeline?.person?.organizations) ? timeline.person.organizations : [];
  const org = person?.lead?.organization ?? {};
  const domain = [
    ...orgs.map((o) => o?.domain),
    relationship?.company?.domain,
    org.primaryDomain,
    org.websiteUrl,
    org.domain,
  ].map(bare).find(Boolean) ?? null;
  if (!domain) {
    console.log("[business-role] the sending line states instructions, but no website is known for this person's business: nothing asked");
    return none;
  }
  return {
    skip: false,
    domain,
    questions: {
      role: { type: "noul", instructions: ${JSON.stringify(BUSINESS_ROLE_QUESTION)}, criteria: ${JSON.stringify(BUSINESS_ROLE_CRITERIA)} },
    },
    state: { assistantName: s(channel.persona.name), assistantRole: s(channel.persona.role), instructions },
  };
}
`.trim();

/** `main(plan, judge, brandId)`: reads the site only on Jev's yes. A judgment that answers nothing throws. */
export const BUSINESS_SITE_PLAN_CODE = `
export async function main(plan, judge, brandId) {
  if (plan?.skip !== false) return { read: false, skip: true };
  const yes = judge?.answers?.role?.noul;
  if (typeof yes !== "number") throw new Error("business-site-plan: Jev returned no answer on the line's instructions: " + JSON.stringify(judge).slice(0, 300));
  if (yes < ${BUSINESS_ROLE_THRESHOLD}) {
    console.log("[business-role] the line's instructions do not ask to answer as the writer's business (" + yes.toFixed(2) + ")");
    return { read: false, skip: true };
  }
  console.log("[business-role] the line answers as the writer's business (" + yes.toFixed(2) + "): reading https://" + plan.domain);
  return { read: true, skip: false, domain: plan.domain, url: "https://" + plan.domain, brandIds: [brandId] };
}
`.trim();

/** `main(site, scrape)`: the writer's block. Inactive = `{active: false}` (the prompt of before). */
export const BUSINESS_ROLE_CODE = `
export async function main(site, scrape) {
  if (site?.read !== true) return { active: false };
  const raw = scrape && scrape.ok !== false && typeof scrape?.result?.rawMarkdown === "string" ? scrape.result.rawMarkdown.trim() : "";
  if (!raw) console.error("[business-role] " + site.domain + " could not be read (" + JSON.stringify(scrape?.error ?? scrape?.status ?? null) + "): the writer answers as that business without its page");
  const clipped = raw.length > ${BUSINESS_SITE_MAX_CHARS} ? raw.slice(0, ${BUSINESS_SITE_MAX_CHARS}) + "..." : raw;
  return { active: true, domain: site.domain, content: clipped || null };
}
`.trim();

/**
 * The prompt lines for an active block (`businessRoleLines(business)`), and the message lines
 * (`businessMessageLines(business)`). Both return [] when inactive, so the prompt is byte for byte the one of before.
 */
export const BUSINESS_ROLE_FN = `
function businessRoleLines(business) {
  if (!business || business.active !== true) return [];
  return [
    "THEIR BUSINESS: your own instructions ask you to answer as the business of the person writing, and that business is " + business.domain + ". In this message you are that business's assistant: answer what they asked the way that business's assistant would answer one of its customers, from THEIR BUSINESS below (read live from its site). Name it as its own site names it.",
    "In that role the FACTS about us and our offer are not what you answer from, and you never sell our offer in this message. Never invent a price, an opening hour, a product or a policy: state only what THEIR BUSINESS shows, exactly as written.",
  ];
}

function businessMessageLines(business) {
  if (!business || business.active !== true) return [];
  return [
    "",
    "THEIR BUSINESS (" + business.domain + ", read live from its site; the only source when you answer as it):",
    business.content ?? "(the site could not be read: nothing about this business is known)",
  ];
}
`.trim();

/** The four nodes, in order, between `who-they-are` and `compose`. Refs name whole outputs. */
export function businessRoleNodes(refs: { channel: string; timeline: string; relationship: string; person: string; brandId: string }): DAGNode[] {
  return [
    {
      id: "business-role-plan",
      type: "script",
      config: { code: BUSINESS_ROLE_PLAN_CODE },
      retries: 0,
      inputMapping: { channel: refs.channel, timeline: refs.timeline, relationship: refs.relationship, person: refs.person },
    },
    {
      id: "business-role-judge",
      type: "http.call",
      config: { service: "chat", method: "POST", path: "/orgs/judgments" },
      retries: 1,
      inputMapping: {
        "body.state": "$ref:business-role-plan.output.state",
        "body.questions": "$ref:business-role-plan.output.questions",
        skip: "$ref:business-role-plan.output.skip",
      },
    },
    {
      id: "business-site-plan",
      type: "script",
      config: { code: BUSINESS_SITE_PLAN_CODE },
      retries: 0,
      inputMapping: { plan: "$ref:business-role-plan.output", judge: "$ref:business-role-judge.output", brandId: refs.brandId },
    },
    {
      id: "business-site-read",
      type: "http.call",
      // Enrichment: an unreadable site is said to the writer, never a failed run.
      config: { service: "scraping", method: "POST", path: "/scrape", body: { enrich: false, featureSlug: SCRAPE_FEATURE_SLUG }, tolerateFailure: true },
      retries: 0,
      inputMapping: {
        "body.url": "$ref:business-site-plan.output.url",
        "body.brandIds": "$ref:business-site-plan.output.brandIds",
        "body.campaignId": "$ref:flow_input.campaignId",
        "body.workflowSlug": "$ref:flow_input.workflowSlug",
        skip: "$ref:business-site-plan.output.skip",
      },
    },
    {
      id: "business-role",
      type: "script",
      config: { code: BUSINESS_ROLE_CODE },
      retries: 0,
      inputMapping: { site: "$ref:business-site-plan.output", scrape: "$ref:business-site-read.output" },
    },
  ];
}

export const BUSINESS_ROLE_NODE_IDS = ["business-role-plan", "business-role-judge", "business-site-plan", "business-site-read", "business-role"] as const;
