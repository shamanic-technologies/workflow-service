import { describe, it, expect, vi, afterEach } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { buildAiMeetingBookingDag, isConversationResponder } from "../../src/lib/ai-meeting-booking-dag.js";
import {
  DESCRIPTION,
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
const parent = buildAiMeetingBookingDag(cell);
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
    ]);
  });

  it("changes nothing of the parent but the writer's prompt source and the send's optional attachments", () => {
    for (const n of parent.nodes) {
      const mine = dag.nodes.find((m) => m.id === n.id)!;
      if (n.id === "draft-reply") {
        expect(mine.config).toEqual(n.config);
        expect(mine.inputMapping).toEqual({
          "body.message": "$ref:pick-document.output.message",
          "body.systemPrompt": "$ref:pick-document.output.systemPrompt",
        });
      } else if (n.id === "send-reply") {
        expect(mine.config).toEqual(n.config);
        expect(mine.inputMapping).toEqual({ ...n.inputMapping, "body.attachments": "$ref:pick-document.output.attachments" });
      } else {
        expect(mine).toEqual(n);
      }
    }
    const parentEdges = parent.edges.filter((e) => !(e.from === "compose-prompt" && e.to === "draft-reply"));
    for (const e of parentEdges) expect(dag.edges).toContainEqual(e);
    expect(dag.edges).toContainEqual({ from: "pick-document", to: "draft-reply" });
  });

  it("reads brand-service's list, asks Jev (skipped when no document can ride), never the writer model", () => {
    const read = dag.nodes.find((n) => n.id === "offer-documents")!;
    expect(read.config).toMatchObject(OFFER_DOCUMENTS_READ);
    expect(read.inputMapping).toEqual({ "params.offerId": "$ref:campaign-detail.output.campaign.offerId" });
    const judge = dag.nodes.find((n) => n.id === "judge-document")!;
    expect(judge.config).toMatchObject({ service: "chat", method: "POST", path: "/orgs/judgments" });
    expect(judge.inputMapping?.skip).toBe("$ref:plan-document.output.skip");
  });

  it("drops the attachments key from the send body when nothing is picked (undefined is not serialized)", () => {
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
    expect(out).toEqual({ message: "PARENT MESSAGE", systemPrompt: "PARENT SYSTEM", attachments: undefined, document: null });
  });

  it("with no documents, never reads Jev and leaves the parent's prompt as is", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = await plan({ documents: [] }, emailThread, smtpConversation, prompt);
    const out = await pick(planned, { ok: false, skipped: true, notCalled: true }, prompt);
    expect(out.message).toBe("PARENT MESSAGE");
    expect(out.attachments).toBeUndefined();
  });

  it("fails loud on a Jev answer with no document choice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const planned = await plan(docs, emailThread, smtpConversation, prompt);
    await expect(pick(planned, { answers: {} }, prompt)).rejects.toThrow(/no document choice/);
  });
});
