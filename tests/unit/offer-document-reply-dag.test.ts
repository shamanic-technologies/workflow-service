import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import {
  GROUND_DRAFT_CODE,
  REPLY_RESPONSE_SCHEMA,
  buildAiMeetingBookingDagUnvoiced,
  isConversationResponder,
} from "../../src/lib/ai-meeting-booking-dag.js";
import {
  DESCRIPTION,
  GROUND_DRAFT_WITH_DOCUMENT_CODE,
  NO_DOCUMENT_OPTION,
  OFFER_DOCUMENTS_READ,
  PICK_DOCUMENT_CODE,
  PLAN_DOCUMENT_CODE,
  buildOfferDocumentReplyDag,
  isOfferDocumentResponder,
} from "../../src/lib/offer-document-reply-dag.js";

function loadMain(code: string): (...args: unknown[]) => Promise<Record<string, unknown>> {
  const body = code.replace(/^export async function main/m, "async function main") + "\nreturn main;";
  return new Function(body)() as (...args: unknown[]) => Promise<Record<string, unknown>>;
}

afterEach(() => vi.restoreAllMocks());

const cell = { provider: "anthropic", model: "opus", omitTemperature: true };
// The responder before our voice: this copy splices its document step, then voices its own draft.
const parent = buildAiMeetingBookingDagUnvoiced(cell);
const dag = buildOfferDocumentReplyDag(cell);

const docs = {
  documents: [
    { id: "d-1", fileName: "fda-510k-case-study.pdf", description: "How we cleared a 510(k) for a class II device." },
    { id: "d-2", fileName: "pricing-one-pager.pdf", description: "Our audit packages and prices." },
  ],
};
const emailThread = {
  replyChannel: "email",
  conversation: {
    messages: [
      { direction: "outbound", text: "Would a QA audit help?" },
      { direction: "inbound", text: "can you share a case study on 510(k)?" },
    ],
  },
};
const smtpConversation = { conversation: { transport: "smtp", sequences: [{ transport: "smtp" }] } };
const prompt = { message: "PARENT MESSAGE", systemPrompt: "PARENT SYSTEM", stance: "insider" };

describe("the offer-document responder DAG", () => {
  it("is the parent DAG plus four nodes, valid and convertible", () => {
    expect(validateDAG(dag).errors).toEqual([]);
    expect(() => dagToOpenFlow(dag, "offer-document-reply-test")).not.toThrow();
    const ids = dag.nodes.map((n) => n.id);
    for (const n of parent.nodes) expect(ids).toContain(n.id);
    expect(ids.filter((id) => !parent.nodes.some((n) => n.id === id))).toEqual([
      "offer-documents",
      "plan-document",
      "judge-document",
      "pick-document",
      "read-client-comms",
      "client-comms-voice",
      // BEST-TPL-LLM-1022: the writer's LLM is the leg's pick.
      "llm-pick",
      "llm-plan",
    ]);
  });

  it("changes nothing of the parent but the writer's prompt + schema source, the grounding guard and the send's optional attachments", () => {
    for (const n of parent.nodes) {
      const mine = dag.nodes.find((m) => m.id === n.id)!;
      if (n.id === "draft-reply") {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { responseSchema, provider, model, temperature, ...rest } = (n.config!.body as Record<string, unknown>);
        expect(responseSchema).toEqual(REPLY_RESPONSE_SCHEMA);
        expect(mine.config).toEqual({ ...n.config, body: rest });
        expect(mine.inputMapping).toEqual({
          "body.message": "$ref:pick-document.output.message",
          "body.systemPrompt": "$ref:client-comms-voice.output.systemPrompt",
          "body.responseSchema": "$ref:pick-document.output.responseSchema",
          "body.provider": "$ref:llm-plan.output.provider",
          "body.model": "$ref:llm-plan.output.model",
        });
      } else if (n.id === "ground-draft") {
        expect(mine.config).toEqual({ ...n.config, code: GROUND_DRAFT_WITH_DOCUMENT_CODE });
        expect(mine.inputMapping).toEqual({ ...n.inputMapping, attachedDocument: "$ref:pick-document.output.document" });
      } else if (n.id === "send-reply") {
        expect(mine.config).toEqual(n.config);
        expect(mine.inputMapping).toEqual({ ...n.inputMapping, "body.attachments": "$ref:pick-document.output.attachments" });
      } else if (n.id === "record-followup") {
        // BEST-TPL-LLM-1022: the act names the LLM the writer actually used.
        expect(mine).toEqual({ ...n, inputMapping: { ...n.inputMapping, "body.llmAlias": "$ref:llm-plan.output.model" } });
      } else {
        expect(mine).toEqual(n);
      }
    }
    const parentEdges = parent.edges.filter((e) => !(e.from === "compose-prompt" && e.to === "draft-reply"));
    for (const e of parentEdges) expect(dag.edges).toContainEqual(e);
    expect(dag.edges).toContainEqual({ from: "pick-document", to: "read-client-comms" });
    expect(dag.edges).toContainEqual({ from: "client-comms-voice", to: "llm-pick" });
    expect(dag.edges).toContainEqual({ from: "llm-plan", to: "draft-reply" });
    // Our voice goes on the prompt the document step hands the writer.
    expect(dag.nodes.find((n) => n.id === "client-comms-voice")?.inputMapping?.systemPrompt).toBe("$ref:pick-document.output.systemPrompt");
  });

  it("reads brand-service's list, asks Jev (skipped when no document can ride), never the writer model", () => {
    const read = dag.nodes.find((n) => n.id === "offer-documents")!;
    expect(read.config).toMatchObject(OFFER_DOCUMENTS_READ);
    expect(read.inputMapping).toEqual({ "params.offerId": "$ref:campaign-detail.output.campaign.offerId" });
    const judge = dag.nodes.find((n) => n.id === "judge-document")!;
    expect(judge.config).toMatchObject({ service: "chat", method: "POST", path: "/orgs/judgments" });
    expect(judge.inputMapping?.skip).toBe("$ref:plan-document.output.skip");
  });

  it("maps the send's attachments from pick-document (an empty list when nothing rides: Windmill turns undefined into null, which instantly refuses)", () => {
    const flow = JSON.stringify(dagToOpenFlow(dag, "offer-document-reply-test"));
    expect(flow).toContain("results.pick_document?.attachments");
  });

  it("is told apart from the parent, so the parent seed never overwrites it", () => {
    expect(isOfferDocumentResponder(dag)).toBe(true);
    expect(isOfferDocumentResponder(parent)).toBe(false);
    expect(isConversationResponder(dag)).toBe(false);
    expect(isConversationResponder(parent)).toBe(true);
  });

  it("says plainly that it attaches a relevant offer document", () => {
    expect(DESCRIPTION).toMatch(/attaches the most relevant offer document/);
    expect(DESCRIPTION).not.toMatch(/[–—]/);
  });
});

describe("planning the document choice", () => {
  const main = loadMain(PLAN_DOCUMENT_CODE);
  const quiet = () => vi.spyOn(console, "log").mockImplementation(() => {});

  it("builds one Jev choice over every document plus none, from name, description and their last message", async () => {
    quiet();
    const out = await main(docs, emailThread, smtpConversation, prompt);
    expect(out.skip).toBe(false);
    const q = (out.questions as { document: { type: string; criteria: Record<string, string> } }).document;
    expect(q.type).toBe("choice");
    expect(q.criteria).toEqual({
      doc_1: "fda-510k-case-study.pdf: How we cleared a 510(k) for a class II device.",
      doc_2: "pricing-one-pager.pdf: Our audit packages and prices.",
      [NO_DOCUMENT_OPTION]: expect.any(String),
    });
    expect((out.state as { prospectLastMessage: string }).prospectLastMessage).toBe("can you share a case study on 510(k)?");
    expect(out.documents).toEqual([
      expect.objectContaining({ option: "doc_1", id: "d-1", name: "fda-510k-case-study.pdf" }),
      expect.objectContaining({ option: "doc_2", id: "d-2", name: "pricing-one-pager.pdf" }),
    ]);
  });

  it.each([
    ["no documents on the offer", { documents: [] }, emailThread, smtpConversation, prompt, /no documents/],
    ["a WhatsApp reply", docs, { ...emailThread, replyChannel: "whatsapp" }, smtpConversation, prompt, /whatsapp/],
    ["a thread on the Instantly pipe", docs, emailThread, { conversation: { transport: "instantly", sequences: [{ transport: "smtp" }, { transport: "instantly" }] } }, prompt, /carries no file/],
    ["a blind thread", docs, emailThread, smtpConversation, { ...prompt, stance: "blind" }, /never named the client/],
  ])("asks Jev nothing on %s", async (_label, d, t, c, p, why) => {
    quiet();
    const out = await main(d, t, c, p);
    expect(out.skip).toBe(true);
    expect(out.why).toMatch(why);
  });

  it("fails loud when brand-service served no documents array", async () => {
    await expect(main({ ok: false, status: 500 }, emailThread, smtpConversation, prompt)).rejects.toThrow(/no documents array/);
  });
});

describe("picking the document", () => {
  const plan = loadMain(PLAN_DOCUMENT_CODE);
  const pick = loadMain(PICK_DOCUMENT_CODE);
  const judged = (choice: string, p: number) => ({
    answers: { document: { type: "choice", choice, confidence: p, probabilities: { [choice]: p } } },
  });

  it("attaches the case study a prospect asked for, and tells the writer to mention it in one sentence", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = await plan(docs, emailThread, smtpConversation, prompt);
    const out = await pick(planned, judged("doc_1", 0.93), prompt);
    expect(out.attachments).toEqual([{ document_id: "d-1" }]);
    const sources = (out.responseSchema as typeof REPLY_RESPONSE_SCHEMA).properties.answers.items.properties.source.enum;
    expect(sources).toContain("document");
    expect(out.message as string).toContain("answer source document");
    expect(out.systemPrompt).toBe("PARENT SYSTEM");
    expect(out.message as string).toMatch(/^PARENT MESSAGE\n/);
    expect(out.message as string).toContain("\"fda-510k-case-study.pdf\"");
    expect(out.message as string).toContain("one short plain sentence");
    expect(out.message as string).not.toMatch(/[–—]/);
  });

  it.each([
    ["Jev says none (\"sure, Tuesday works\")", judged(NO_DOCUMENT_OPTION, 0.97)],
    ["Jev hesitates", judged("doc_2", 0.4)],
  ])("sends the parent's prompt unchanged and no attachments key when %s", async (_label, judge) => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = await plan(docs, emailThread, smtpConversation, prompt);
    const out = await pick(planned, judge, prompt);
    expect(out).toEqual({ message: "PARENT MESSAGE", systemPrompt: "PARENT SYSTEM", responseSchema: REPLY_RESPONSE_SCHEMA, attachments: [], document: null });
  });

  it("with no documents, never reads Jev and leaves the parent's prompt as is", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = await plan({ documents: [] }, emailThread, smtpConversation, prompt);
    const out = await pick(planned, { ok: false, skipped: true, notCalled: true }, prompt);
    expect(out.message).toBe("PARENT MESSAGE");
    expect(out.attachments).toEqual([]);
  });

  it("replies without a file, loudly, when Jev could not judge (the prospect is still answered)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const planned = await plan(docs, emailThread, smtpConversation, prompt);
    const out = await pick(planned, { ok: false, status: 502, error: "Judgment failed" }, prompt);
    expect(out).toEqual({ message: "PARENT MESSAGE", systemPrompt: "PARENT SYSTEM", responseSchema: REPLY_RESPONSE_SCHEMA, attachments: [], document: null });
    expect(err.mock.calls[0]?.[0]).toContain("Jev could not judge");
    expect(dag.nodes.find((n) => n.id === "judge-document")!.config).toMatchObject({ tolerateFailure: true });
  });

  it("fails loud on a Jev answer with no document choice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = await plan(docs, emailThread, smtpConversation, prompt);
    await expect(pick(planned, { answers: {} }, prompt)).rejects.toThrow(/no document choice/);
  });
});

describe("grounding a reply that answers with the attached document", () => {
  const facts = { questions: [{ key: "q1", question: "Can you share a case study on 510(k)?" }], exact: [] };
  const draft = {
    json: { decision: "answer", question: "Can you share a case study on 510(k)?", reason: "attached", replyHtml: "<p>I attached our 510(k) case study.</p>", answers: [{ key: "q1", source: "document", facts: [] }] },
  };
  const args = [draft, facts, { stance: "insider" }, { name: "Audits" }, { brand: { name: "Acme" } }, "none", { asked: false }];
  const quiet = () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  };

  it("sends it when a file rides on the reply (the parent would escalate: no client fact covers it)", async () => {
    quiet();
    const out = await loadMain(GROUND_DRAFT_WITH_DOCUMENT_CODE)(...args, { id: "d-1", name: "case.pdf" });
    expect(out.overridden).toBe(false);
    expect((out.json as { decision: string }).decision).toBe("answer");
    const parentOut = await loadMain(GROUND_DRAFT_CODE)(...args);
    expect((parentOut.json as { decision: string }).decision).toBe("escalate");
  });

  it("escalates a document answer when no file rides, exactly like the parent", async () => {
    quiet();
    const out = await loadMain(GROUND_DRAFT_WITH_DOCUMENT_CODE)(...args, null);
    expect((out.json as { decision: string }).decision).toBe("escalate");
  });
});
