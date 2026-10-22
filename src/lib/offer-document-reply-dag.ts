/**
 * The `ai-meeting-booking` conversation responder that ATTACHES THE MOST RELEVANT OFFER DOCUMENT, when one helps.
 *
 * A client uploads sales documents on its offer (a case study, a pricing one-pager) in brand-service. When a
 * prospect answers and this workflow replies by email, ONE of those documents rides on the reply when it helps
 * that prospect, and none when none does. Everything else is its parent's, byte for byte: the DAG is
 * `buildAiMeetingBookingDag` plus four nodes spliced between `compose-prompt` and `draft-reply`, and one optional
 * field on the send.
 *
 *  - `offer-documents`: brand-service lists the offer's documents (`fileName` + `description`, no bytes; x-org-id
 *    scoped, so another org's offer is a 404 that fails the run loud).
 *  - `plan-document`: decides whether a document CAN ride on this reply at all, and builds the question. It
 *    cannot when the offer has none, the reply goes out on another channel than email, the thread runs on a
 *    transport that carries no file (instantly-service refuses an attachment on its Instantly pipe), or the
 *    thread is BLIND (a client document names the client, which a blind thread never does).
 *  - `judge-document`: "is one of these documents useful here, and which?" is a classification, so Jev answers
 *    it (chat-service `/orgs/judgments`, a `choice` over the documents + `none`, judged on each document's name
 *    and description against the prospect's last message). Never the writer model, never a rule. Skipped (not
 *    called, nothing billed) when `plan-document` says no document can ride. `tolerateFailure`: a judgment that
 *    fails (TypeSafe out of credits, 2026-10-14) means no file, logged loudly, and the reply still goes out.
 *  - `pick-document`: keeps the winner only when Jev gives it at least `ATTACH_MIN_PROBABILITY`, and adds ONE
 *    section to the writer's prompt naming the file, so the reply mentions it in one short sentence. A question the
 *    file answers takes the answer source `document` (writer schema + `ground-draft`, both only on a run carrying a
 *    file), or the grounding guard would escalate "can you share a case study?" for want of a client fact.
 *
 * With nothing picked the writer's prompt and schema are the parent's, unchanged, `ground-draft` accepts exactly
 * the parent's sources, and `send-reply` carries `attachments: []`, which instantly-service treats exactly as absent:
 * the run IS the parent's run. Never `undefined`: Windmill hands an absent script field to the next node as `null`, and
 * instantly-service refuses `attachments: null` with a 400, so the no-file reply was never sent (staff AC run, 2026-10-14).
 *
 * Spend: Jev is declared by chat-service on this run, the send by instantly-service. Nothing here spends.
 */
import { withClientCommsVoice } from "./client-comms.js";
import { withLegBestLlm } from "./leg-best-writer.js";
import type { DAG, DAGNode } from "./dag-validator.js";
import {
  GROUND_DRAFT_CODE,
  REPLY_RESPONSE_SCHEMA,
  buildAiMeetingBookingDagUnvoiced,
  withActNamingWriter,
  type AiMeetingBookingDagOptions,
} from "./ai-meeting-booking-dag.js";

/** brand-service's list of an offer's documents. Wired against its served contract. */
export const OFFER_DOCUMENTS_READ = {
  service: "brand",
  method: "GET",
  path: "/internal/offers/{offerId}/documents",
} as const;

/** Jev's option for "no document fits". */
export const NO_DOCUMENT_OPTION = "none";

/** The probability Jev must give the winning document for it to ride. Below it, the reply goes out bare. */
export const ATTACH_MIN_PROBABILITY = 0.5;

/** Jev takes at most 255 options; an offer with more is judged on its first ones, in brand-service's order. */
export const MAX_JUDGED_DOCUMENTS = 50;

/**
 * The answer source of a question the attached document answers ("can you share a case study?"). Without it the
 * parent's grounding guard counts such a question as unanswered (no client fact covers it) and escalates, so the
 * file would never be sent (staff AC run, 2026-10-14). The writer is offered it, and `ground-draft` accepts it,
 * ONLY on a run that carries a file: with none, both are the parent's byte for byte.
 */
export const DOCUMENT_ANSWER_SOURCE = "document";

/** The writer's schema on a run that carries a file: the parent's, plus the `document` answer source. */
export const REPLY_RESPONSE_SCHEMA_WITH_DOCUMENT = (() => {
  const schema = JSON.parse(JSON.stringify(REPLY_RESPONSE_SCHEMA));
  const answers = schema.properties.answers;
  answers.items.properties.source.enum = [...answers.items.properties.source.enum.filter((v: string) => v !== "none"), DOCUMENT_ANSWER_SOURCE, "none"];
  answers.description = answers.description.replace(
    "none = nothing in front of you answers it.",
    "document = answered by the document this reply carries (only when you are told one rides on it); none = nothing in front of you answers it.",
  );
  return schema;
})();

/** The parent's grounding guard, also accepting `document` when (and only when) a file rides on the reply. */
export const GROUND_DRAFT_WITH_DOCUMENT_CODE = (() => {
  const signature = "export async function main(draft, facts, identity, offer, brand, playbook, callRequest) {";
  const callSource = 'if (callRequest?.asked === true) sources.push("call");';
  if (!GROUND_DRAFT_CODE.includes(signature) || !GROUND_DRAFT_CODE.includes(callSource)) {
    throw new Error("offer-document-reply: the parent ground-draft code changed shape; re-derive the document source");
  }
  return GROUND_DRAFT_CODE.replace(signature, signature.replace("callRequest)", "callRequest, attachedDocument)")).replace(
    callSource,
    callSource + "\n    if (attachedDocument) sources.push(" + JSON.stringify(DOCUMENT_ANSWER_SOURCE) + ");",
  );
})();

/** The marker the parent seed reads to leave this workflow alone. */
export const DOCUMENT_NODE_ID = "offer-documents";

export const DESCRIPTION =
  "Answers one prospect who showed sales interest, like the AI meeting booking responder, and attaches the most " +
  "relevant offer document to the email reply when one helps: a case study, a one-pager the client uploaded on " +
  "the offer. Jev picks one document or none from each document's name and description and the prospect's message; " +
  "the reply mentions the attached file in one short sentence. With no document on the offer, or none relevant, " +
  "it replies exactly like the AI meeting booking responder. Answers leads only: every follow-up claim asks " +
  "lead-service for pure prospects of the brand (relationships pure_prospect), so a personal contact, a customer, " +
  "team member, investor, partner, supplier or advisor of the brand is refused by lead-service and never answered.";

export const PLAN_DOCUMENT_CODE = `
export async function main(documents, thread, conversation, prompt) {
  const NONE = NONE_OPTION;
  const listed = Array.isArray(documents?.documents) ? documents.documents : null;
  if (!listed) {
    throw new Error("[offer-document-reply] brand-service served no documents array for this offer: " + JSON.stringify(documents).slice(0, 300));
  }
  const usable = listed
    .filter((d) => d && typeof d.id === "string" && d.id && typeof d.fileName === "string" && d.fileName.trim())
    .slice(0, MAX_DOCS);
  const sequences = conversation?.conversation?.sequences ?? [];
  const transports = sequences.length > 0 ? sequences.map((s) => s?.transport) : [conversation?.conversation?.transport];
  const why =
    usable.length === 0 ? "the offer has no documents"
    : thread?.replyChannel !== "email" ? "the reply goes out on " + String(thread?.replyChannel) + ", not email"
    : !transports.every((t) => t === "smtp") ? "the thread runs on a transport that carries no file (" + transports.join(", ") + ")"
    : prompt?.stance === "blind" ? "the thread never named the client, and a client document would"
    : null;
  if (why) {
    console.log("[offer-document-reply] no document considered: " + why);
    return { skip: true, why, documents: [], state: null, questions: null };
  }

  const inbound = (thread?.conversation?.messages ?? []).filter((m) => m?.direction === "inbound");
  const last = inbound[inbound.length - 1];
  const criteria = {};
  usable.forEach((d, i) => {
    const description = typeof d.description === "string" && d.description.trim() ? d.description.trim() : "no description";
    criteria["doc_" + (i + 1)] = d.fileName.trim() + ": " + description;
  });
  criteria[NONE] = "None of these documents answers or supports what they wrote; the reply needs no file.";
  console.log("[offer-document-reply] judging " + usable.length + " document(s) against their last message");
  return {
    skip: false,
    why: null,
    documents: usable.map((d, i) => ({ option: "doc_" + (i + 1), id: d.id, name: d.fileName.trim(), description: d.description ?? null })),
    state: { prospectLastMessage: String(last?.text ?? ""), offerDocuments: Object.fromEntries(Object.entries(criteria).filter(([k]) => k !== NONE)) },
    questions: {
      document: {
        type: "choice",
        instructions:
          "A prospect wrote this to a company that sells to them. Would sending them one of the company's documents, " +
          "attached to our answer, directly help with what they wrote (they asked for it, or it answers their question)? " +
          "Pick that document, or none when no document fits or their message needs no file.",
        criteria,
      },
    },
  };
}
`
  .trim()
  .replace("NONE_OPTION", JSON.stringify(NO_DOCUMENT_OPTION))
  .replace("MAX_DOCS", String(MAX_JUDGED_DOCUMENTS));

export const PICK_DOCUMENT_CODE = `
export async function main(plan, judge, prompt) {
  const NONE = NONE_OPTION;
  const bare = { message: prompt.message, systemPrompt: prompt.systemPrompt, responseSchema: PARENT_SCHEMA, attachments: [], document: null };
  if (plan?.skip !== false) return bare;
  // Jev could not judge (vendor down, out of credits): the reply still goes out, without a file, as the parent's
  // would. Loud, never silent: an unanswered prospect is worse than an answer with no attachment.
  if (judge?.ok === false) {
    console.error("[offer-document-reply] Jev could not judge the documents (" + String(judge.status) + "): " + String(judge.error ?? "").slice(0, 300) + "; replying without a file");
    return bare;
  }
  const answer = judge?.answers?.document;
  if (!answer || answer.type !== "choice") {
    throw new Error("[offer-document-reply] Jev returned no document choice: " + JSON.stringify(judge).slice(0, 300));
  }
  const p = Number(answer.probabilities?.[answer.choice] ?? 0);
  const doc = (plan.documents ?? []).find((d) => d.option === answer.choice);
  if (answer.choice === NONE || !doc || p < MIN_P) {
    console.log("[offer-document-reply] no document attached (Jev: " + answer.choice + " at " + p.toFixed(2) + ")");
    return bare;
  }
  console.log("[offer-document-reply] attaching " + doc.id + " (" + doc.name + "), Jev " + p.toFixed(2));
  const section = [
    "",
    "THE FILE THIS REPLY CARRIES",
    "This reply goes out with one document attached: \\"" + doc.name + "\\"" + (doc.description ? " (" + doc.description + ")" : "") + ".",
    "If you write a reply, mention the attachment once, in one short plain sentence where it fits (for example that you attached it). No hype, and say nothing about its content beyond what is written here.",
    "A question this file answers (they asked for it, or for what it is) is answered by attaching it: give that question the answer source document. Every other question keeps its usual sources.",
  ].join("\\n");
  return {
    message: prompt.message + "\\n" + section,
    systemPrompt: prompt.systemPrompt,
    responseSchema: DOCUMENT_SCHEMA,
    attachments: [{ document_id: doc.id }],
    document: { id: doc.id, name: doc.name, probability: p },
  };
}
`
  .trim()
  .replace("NONE_OPTION", JSON.stringify(NO_DOCUMENT_OPTION))
  .replace("MIN_P", String(ATTACH_MIN_PROBABILITY))
  .replace("PARENT_SCHEMA", JSON.stringify(REPLY_RESPONSE_SCHEMA))
  .replace("DOCUMENT_SCHEMA", JSON.stringify(REPLY_RESPONSE_SCHEMA_WITH_DOCUMENT));

/** True when a stored DAG is THIS workflow (the parent seed must never upgrade it with the parent DAG). */
export function isOfferDocumentResponder(dag: { nodes?: Array<{ id?: string }> } | null | undefined): boolean {
  return (dag?.nodes ?? []).some((n) => n?.id === DOCUMENT_NODE_ID);
}

export function buildOfferDocumentReplyDag(opts: AiMeetingBookingDagOptions): DAG {
  const parent = buildAiMeetingBookingDagUnvoiced(opts);
  const added: DAGNode[] = [
    {
      id: DOCUMENT_NODE_ID,
      type: "http.call",
      config: { ...OFFER_DOCUMENTS_READ },
      inputMapping: { "params.offerId": "$ref:campaign-detail.output.campaign.offerId" },
    },
    {
      id: "plan-document",
      type: "script",
      config: { code: PLAN_DOCUMENT_CODE },
      retries: 0,
      inputMapping: {
        documents: `$ref:${DOCUMENT_NODE_ID}.output`,
        thread: "$ref:thread.output",
        conversation: "$ref:conversation.output",
        prompt: "$ref:compose-prompt.output",
      },
    },
    {
      id: "judge-document",
      type: "http.call",
      // A failed judgment is an OUTCOME (no file), not a reason to leave the prospect unanswered.
      config: { service: "chat", method: "POST", path: "/orgs/judgments", tolerateFailure: true },
      retries: 1,
      inputMapping: {
        "body.state": "$ref:plan-document.output.state",
        "body.questions": "$ref:plan-document.output.questions",
        skip: "$ref:plan-document.output.skip",
      },
    },
    {
      id: "pick-document",
      type: "script",
      config: { code: PICK_DOCUMENT_CODE },
      retries: 0,
      inputMapping: {
        plan: "$ref:plan-document.output",
        judge: "$ref:judge-document.output",
        prompt: "$ref:compose-prompt.output",
      },
    },
  ];

  const nodes: DAGNode[] = [];
  for (const node of parent.nodes) {
    if (node.id === "draft-reply") {
      nodes.push(...added);
      const { responseSchema: _parentSchema, ...body } = (node.config?.body ?? {}) as Record<string, unknown>;
      nodes.push({
        ...node,
        config: { ...node.config, body },
        inputMapping: {
          ...node.inputMapping,
          "body.message": "$ref:pick-document.output.message",
          "body.systemPrompt": "$ref:pick-document.output.systemPrompt",
          "body.responseSchema": "$ref:pick-document.output.responseSchema",
        },
      });
    } else if (node.id === "ground-draft") {
      nodes.push({
        ...node,
        config: { ...node.config, code: GROUND_DRAFT_WITH_DOCUMENT_CODE },
        inputMapping: { ...node.inputMapping, attachedDocument: "$ref:pick-document.output.document" },
      });
    } else if (node.id === "send-reply") {
      nodes.push({ ...node, inputMapping: { ...node.inputMapping, "body.attachments": "$ref:pick-document.output.attachments" } });
    } else {
      nodes.push(node);
    }
  }

  const edges = parent.edges.flatMap((e) =>
    e.from === "compose-prompt" && e.to === "draft-reply"
      ? [
          { from: "compose-prompt", to: DOCUMENT_NODE_ID },
          { from: DOCUMENT_NODE_ID, to: "plan-document" },
          { from: "plan-document", to: "judge-document" },
          { from: "judge-document", to: "pick-document" },
          { from: "pick-document", to: "draft-reply" },
        ]
      : [e],
  );
  if (edges.length !== parent.edges.length + 4) {
    throw new Error("offer-document-reply: the parent DAG no longer has a compose-prompt -> draft-reply edge to splice into");
  }
  // Our voice (the `client-comms` skill, read live) goes on the prompt the document step hands the writer.
  return withActNamingWriter(withLegBestLlm(withClientCommsVoice({ ...parent, nodes, edges }, "draft-reply"), "draft-reply"));
}
