/**
 * WHO THIS PERSON IS TO THE BRAND, read before ANY message is written to them (RELATIONSHIP-TAGS-1014).
 *
 * Incident 2026-10-12/13: WhatsApp and email campaigns to the brand's own signups "who never talked with us" reached
 * friends and workshop contacts the owner talks with every week. Their signup and their WhatsApp presence were never
 * tied together, so every writer believed they were strangers and wrote them a cold introduction. Owner: « TU NE
 * DEVRAIT JAMAIS ASSUME QUE JE NE LES CONNAIS PAS ».
 *
 * lead-service owns who a person is to the brand: the `relationship` block (tags Personal / Customer / Prospect /
 * Team / Investor / Advisor / Supplier / Partner / Other professional, each yes / unsure, judged on the person's
 * whole merged thread) served on `GET /orgs/leads/{id}/relationship` (`relationship`, same id as the lead detail,
 * which itself carries none) and on the lead handed by `POST /orgs/buffer/next` (`lead.data.relationship`). crm-service owns the person's whole merged thread
 * (`GET /orgs/people/timeline`, every channel).
 *
 * This module is the ONE shared step every writer runs before writing (cold WhatsApp outreach, the conversation
 * responder, the follow-up email, the form responder, and every cold email written by content-generation, where
 * `dag-to-openflow.ts` adds the same step at conversion time): `WHO_THEY_ARE_CODE` reads both and returns the
 * relationship in plain lines, the thread in plain lines, and `PERSON_RELATIONSHIP_STRATEGY`, the strategy the
 * writer is told. No per writer variant, no canned reply per case (owner rule): the model is told the game.
 *
 * Never a fallback that reads "stranger": a person whose relationship was never served or never judged is
 * POSSIBLY KNOWN, and the writer is told to read the thread before assuming anything.
 */
import type { DAGNode } from "./dag-validator.js";

/** lead-service's vocabulary (RELATIONSHIP-TAGS-1014, LOCKED). */
export const RELATIONSHIP_TAGS = [
  "personal",
  "customer",
  "prospect",
  "team",
  "investor",
  "advisor",
  "supplier",
  "partner",
  "other_professional",
] as const;

/** A person carrying one of these is someone the brand already knows: never written to as a stranger. */
export const KNOWN_RELATIONSHIP_TAGS = ["personal", "customer", "team", "investor", "advisor", "partner", "supplier"] as const;

/** Timeline sources that carry MESSAGES: one of them unreadable means the thread is unreadable. */
const THREAD_MESSAGE_SOURCES = ["gmail", "matrix", "instantly", "copilot"];

/**
 * The strategy every writer is told, word for word. Explains the game, never a reply per case.
 * Kept free of em and en dashes: the model copies the style of its prompt.
 */
export const PERSON_RELATIONSHIP_STRATEGY = [
  "WHO THIS PERSON IS TO US decides how you write, before anything else.",
  "Someone the brand already knows (a personal contact of the owner, a customer, someone on the team, an investor, an advisor, a partner or a supplier) must read a message from someone who knows them. Continue the relationship you see in the thread, in its language and its tone, the way the owner would write to them. Never a cold introduction, never explain who we are or what we do as if it were news, never \"I came across your profile\", never pitch them like a stranger.",
  "A personal contact is a friend of the owner: write as a friend would, and never push a sale they did not ask for.",
  "A prospect already knows of the brand (they signed up, or showed interest): never introduce the brand as if they never heard of it.",
  "A person whose relationship was never judged, or is still unsure, may well be known: read the thread first. If anything in it shows they know us, write as someone who knows them. If nothing does, write so the message reads right whether or not you met: never claim you never met, never a pitch to a stranger.",
  "Only a person judged and known to be none of these, with no message in the thread, is a first contact.",
  "Never mention these tags, and never say that anyone classified them.",
].join(" ");

/**
 * Shared step: `main(relationshipRead, served, timeline)`.
 * - `relationshipRead`: lead-service `GET /orgs/leads/{id}/relationship` output (or its tolerated failure: 404 = no
 *   relationship known, the person is possibly known; anything else throws), or nothing.
 * - `served`: lead-service `POST /orgs/buffer/next` output (`lead.data.relationship`), or nothing.
 * - `timeline`: crm-service `GET /orgs/people/timeline` output (or its tolerated failure). A 404 is "no thread";
 *   any other failure, or a message source that could not be read, throws: nothing is written blind.
 * Returns null when there is no person (a serve that found nobody), else the relationship and the thread.
 */
export const WHO_THEY_ARE_CODE = `
export async function main(relationshipRead, served, timeline) {
  const KNOWN = ${JSON.stringify(KNOWN_RELATIONSHIP_TAGS)};
  const LABEL = {
    personal: "a personal contact of the owner (a friend, someone he knows outside work)",
    customer: "a customer",
    prospect: "a prospect (signed up, or showed interest)",
    team: "on the brand's team",
    investor: "an investor",
    advisor: "an advisor",
    supplier: "a supplier",
    partner: "a partner",
    other_professional: "someone the owner knows professionally",
  };
  if (relationshipRead && relationshipRead.ok === false && relationshipRead.notCalled !== true && relationshipRead.status !== 404) {
    throw new Error("who-they-are: who the person is to the brand could not be read (" + String(relationshipRead.status ?? "no status") + " " + String(relationshipRead.error ?? "").slice(0, 200) + "); nothing is written blind");
  }
  const fromRead = relationshipRead && relationshipRead.ok !== false ? relationshipRead : null;
  const fromServe = served && served.found === true && served.lead ? served.lead : null;
  if (!fromRead && !fromServe && (served?.found === false || served?.ok === false)) return null;

  const rel = fromRead?.relationship ?? fromServe?.data?.relationship ?? null;
  const tags = Array.isArray(rel?.tags) ? rel.tags.filter((t) => typeof t === "string") : [];
  const unsureTags = Array.isArray(rel?.unsureTags) ? rel.unsureTags.filter((t) => typeof t === "string") : [];
  const judged = typeof rel?.judgedAt === "string" && rel.judgedAt !== "";

  // The thread. A tolerated failure: 404 = crm-service knows nobody under that key = no thread.
  let items = [];
  let threadState = "none";
  if (timeline && timeline.ok === false) {
    if (timeline.notCalled === true) threadState = "not_read";
    else if (timeline.status !== 404) {
      throw new Error("who-they-are: the person's thread could not be read (" + String(timeline.status ?? "no status") + " " + String(timeline.error ?? "").slice(0, 200) + "); nothing is written blind");
    }
  } else if (timeline) {
    if (!Array.isArray(timeline.items)) throw new Error("who-they-are: the person's thread came back without items");
    const failed = (timeline.sources ?? []).filter((x) => ${JSON.stringify(THREAD_MESSAGE_SOURCES)}.includes(x?.source) && x?.status === "failed");
    if (failed.length) {
      throw new Error("who-they-are: the person's thread is unreadable (" + failed.map((x) => x.source + ": " + (x.error ?? "failed")).join("; ") + "); nothing is written blind");
    }
    items = timeline.items;
    threadState = "read";
  }
  const clip = (t, n) => { const s = String(t ?? "").replace(/\\s+/g, " ").trim(); return s.length > n ? s.slice(0, n) + "..." : s; };
  const day = (at) => (typeof at === "string" ? at.slice(0, 16).replace("T", " ") : "date unknown");
  const who = (i) => {
    if (i.direction === "inbound") return "THEM";
    if (i.source === "instantly") return "US [automated cold email]";
    if (i.source === "copilot") return "US [AI Copilot]";
    return "US";
  };
  const messages = items.filter((i) => i?.kind === "message" && i.source !== "api" && clip(i.text, 10));
  const threadLines = messages.slice(-40).map((i) =>
    day(i.at) + " | " + i.channel + " | " + who(i) + ": " + (i.subject && i.channel === "email" ? "[" + clip(i.subject, 80) + "] " : "") + clip(i.text, 400));
  const eventLines = items.filter((i) => i?.kind === "event").slice(-8).map((i) => day(i.at) + " | " + i.channel + " | EVENT: " + (i.event?.step ?? "event") + " (" + i.source + ")");
  const talked = messages.length > 0;

  const knownTags = tags.filter((t) => KNOWN.includes(t));
  const state = knownTags.length > 0
    ? "known"
    : !judged || unsureTags.some((t) => KNOWN.includes(t)) || talked
      ? "possibly_known"
      : "not_known";

  const lines = [];
  if (state === "known") lines.push("The brand ALREADY KNOWS this person. They are " + knownTags.map((t) => LABEL[t] ?? t).join(", ") + ".");
  else if (state === "possibly_known") lines.push(judged
    ? "This person MAY be known to the brand: read the thread before assuming anything."
    : "Nobody judged yet whether the brand knows this person: treat them as possibly known, and read the thread before assuming anything.");
  else lines.push("Judged: nothing shows the brand knows this person yet.");
  const other = tags.filter((t) => !KNOWN.includes(t));
  if (other.length) lines.push("Also: " + other.map((t) => LABEL[t] ?? t).join(", ") + ".");
  if (unsureTags.length) lines.push("Possibly (not confirmed): " + unsureTags.map((t) => LABEL[t] ?? t).join(", ") + ".");
  const company = rel?.company?.name ?? rel?.company?.domain ?? null;
  if (company) lines.push("Their company: " + clip(company, 120) + ".");
  const evidence = (Array.isArray(rel?.details) ? rel.details : [])
    .filter((d) => d?.state === "yes" && typeof d.evidence === "string" && d.evidence.trim())
    .slice(0, 6)
    .map((d) => "Why " + (LABEL[d.tag] ?? d.tag) + ": " + clip(d.evidence, 240));
  lines.push(...evidence);
  if (threadState === "read" && !talked) lines.push("No message was ever exchanged with them on record.");

  return {
    state,
    known: state === "known",
    judged,
    tags,
    unsureTags,
    lines,
    hasThread: talked,
    threadLines,
    olderMessagesOmitted: Math.max(0, messages.length - threadLines.length),
    eventLines,
    strategy: ${JSON.stringify(PERSON_RELATIONSHIP_STRATEGY)},
  };
}
`.trim();

/** The node id of the shared step in every writer DAG. */
export const WHO_THEY_ARE_NODE_ID = "who-they-are";

export const RELATIONSHIP_READ_NODE_ID = "relationship-read";

/**
 * lead-service's read of who the person of ONE lead row is to its brand (`{id}` = the lead row id the lead detail
 * reads). Tolerated so `WHO_THEY_ARE_CODE` reads a 404 as "nothing known" and throws on anything else.
 */
export function relationshipReadNode(refs: { leadRowId: string; brandId: string }): DAGNode {
  return {
    id: RELATIONSHIP_READ_NODE_ID,
    type: "http.call",
    config: { service: "lead", method: "GET", path: "/orgs/leads/{id}/relationship", tolerateFailure: true },
    inputMapping: { "params.id": refs.leadRowId, "query.brandId": refs.brandId },
  };
}

/** The shared step as a DAG node. Each ref names a whole node output (`$ref:<node>.output`) or is omitted. */
export function whoTheyAreNode(refs: { relationshipRead?: string; served?: string; timeline: string }): DAGNode {
  return {
    id: WHO_THEY_ARE_NODE_ID,
    type: "script",
    config: { code: WHO_THEY_ARE_CODE },
    retries: 0,
    inputMapping: {
      ...(refs.relationshipRead ? { relationshipRead: refs.relationshipRead } : {}),
      ...(refs.served ? { served: refs.served } : {}),
      timeline: refs.timeline,
    },
  };
}

/**
 * Where the person's thread is read from: crm-service names a person by any identity key, `email:<address>`.
 * `main(email, brandId, served)`: the person's email and brand, or a served lead (`lead.email`, `lead.brandIds`).
 * No person (a serve that found nobody) = `skip: true`: the read is not made.
 */
export const PERSON_THREAD_QUERY_CODE = `
export async function main(email, brandId, served) {
  const lead = served && served.found === true ? served.lead ?? null : null;
  const address = typeof email === "string" && email.trim() ? email : lead?.email;
  const brand = brandId ?? (Array.isArray(lead?.brandIds) ? lead.brandIds[0] : null);
  if (typeof address !== "string" || !address.trim()) {
    if (served && served.found !== true) return { skip: true, query: {} };
    throw new Error("person-thread-query: the person carries no email to find their thread by");
  }
  if (!brand) throw new Error("person-thread-query: the person carries no brand");
  return { skip: false, query: { brandId: brand, personKey: "email:" + address.trim().toLowerCase() } };
}
`.trim();

export const PERSON_THREAD_QUERY_NODE_ID = "person-thread-query";
export const PERSON_THREAD_NODE_ID = "person-thread";

/**
 * The person's whole merged thread (crm-service, every channel): a query script then the read, tolerated so
 * `WHO_THEY_ARE_CODE` reads a 404 as "no thread" and throws on anything else. Each ref is a `$ref:` or omitted.
 */
export function personThreadNodes(refs: { email?: string; brandId?: string; served?: string }): DAGNode[] {
  return [
    {
      id: PERSON_THREAD_QUERY_NODE_ID,
      type: "script",
      config: { code: PERSON_THREAD_QUERY_CODE },
      retries: 0,
      inputMapping: {
        ...(refs.email ? { email: refs.email } : {}),
        ...(refs.brandId ? { brandId: refs.brandId } : {}),
        ...(refs.served ? { served: refs.served } : {}),
      },
    },
    {
      id: PERSON_THREAD_NODE_ID,
      type: "http.call",
      config: { service: "crm", method: "GET", path: "/orgs/people/timeline", tolerateFailure: true },
      inputMapping: {
        query: `$ref:${PERSON_THREAD_QUERY_NODE_ID}.output.query`,
        skip: `$ref:${PERSON_THREAD_QUERY_NODE_ID}.output.skip`,
      },
    },
  ];
}

/** True when a stored writer DAG does not run the shared step yet (a seed upgrades it). */
export function needsPersonRelationship(dag: { nodes?: Array<{ id?: string }> } | null | undefined): boolean {
  return !(dag?.nodes ?? []).some((n) => n?.id === WHO_THEY_ARE_NODE_ID);
}
