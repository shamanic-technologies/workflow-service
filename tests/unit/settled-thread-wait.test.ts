import { describe, expect, it, vi, beforeEach } from "vitest";
import { main } from "../../scripts/nodes/http-call.js";
import { dagToOpenFlow, readsPersonThread, SETTLED_THREAD_WAIT } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildFormMeetingBookingDag } from "../../src/lib/form-meeting-booking-dag.js";
import { buildAiLeadProposalDag } from "../../src/lib/ai-lead-proposal-dag.js";
import { buildAiMeetingBookingDag } from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { buildClientCheckInDag } from "../../src/lib/client-check-in-dag.js";
import { buildFounderHelloDag } from "../../src/lib/founder-hello-dag.js";

/**
 * UNIBOX-FACT-LAG-1028 (prod 2026-10-28, tari@slipless.ng): two card charges were refused at 05:00 and 05:01, the
 * people fact feed held them only from ~05:09:30, and a Lead event WhatsApp sent at 05:11 said "Your $100 topup is
 * going through now". crm-service's person timeline now says `factFeed.settled: false` while a record of the thread
 * is not yet on the fact feed: every person-thread read waits for the settled thread before anything reads it.
 */
const mockFetch = vi.fn();
vi.stubGlobal("Bun", { env: {} });
vi.stubGlobal("fetch", mockFetch);

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const unsettled = { items: [{ source: "payment", text: "Top-up of $100 started" }], factFeed: { settled: false, statedThrough: "2026-10-28T05:00:00Z", pending: [{ source: "stripe", at: "2026-10-28T05:00:39Z", step: "payment_failed", factKey: "k", recordedAt: "2026-10-28T05:00:40Z" }] } };
const settled = { items: [{ source: "payment", text: "Card refused" }], factFeed: { settled: true, statedThrough: "2026-10-28T05:09:30Z", pending: [] } };

const POLL_POSITION = 28;
function readThread(tolerate?: boolean) {
  const args = new Array(POLL_POSITION + 1).fill(undefined);
  ["crm", "GET", "/orgs/people/timeline", undefined, { personKey: "email:tari@slipless.ng" }, { CRM_SERVICE_URL: "https://crm", CRM_SERVICE_API_KEY: "k" }]
    .forEach((v, i) => { args[i] = v; });
  if (tolerate) args[24] = true;
  args[POLL_POSITION] = { ...SETTLED_THREAD_WAIT };
  return (main as (...a: unknown[]) => Promise<Record<string, unknown>>)(...args);
}

describe("a person-thread read waits for crm-service's settled thread (http.call)", () => {
  beforeEach(() => mockFetch.mockReset());

  it("unsettled then settled: reads again and hands on the SETTLED thread only", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockResolvedValueOnce(json(unsettled)).mockResolvedValueOnce(json(unsettled)).mockResolvedValueOnce(json(settled));
      const p = readThread();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await p).toEqual(settled);
      expect(mockFetch).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("settled at once, or no factFeed at all: one read, the answer unchanged", async () => {
    mockFetch.mockResolvedValueOnce(json(settled));
    expect(await readThread()).toEqual(settled);
    const legacy = { items: [{ source: "matrix", text: "hi" }] };
    mockFetch.mockResolvedValueOnce(json(legacy));
    expect(await readThread()).toEqual(legacy);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("still moving when the wait runs out: THROWS, even on a tolerated read (nothing is written on it)", async () => {
    vi.useFakeTimers();
    try {
      mockFetch.mockImplementation(async () => json(unsettled));
      for (const tolerate of [false, true]) {
        const p = readThread(tolerate);
        const settledP = p.then(() => "resolved", (e: Error) => e.message);
        await vi.advanceTimersByTimeAsync(400_000);
        expect(await settledP).toMatch(/factFeed\.settled still false when the wait ran out/);
      }
    } finally {
      vi.useRealTimers();
    }
  });
});

type Mod = { id: string; value: { type: string; path?: string; input_transforms?: Record<string, { type: string; value?: unknown }>; branches?: { modules: Mod[] }[]; default?: Mod[]; modules?: Mod[] } };
const all = (mods: Mod[]): Mod[] =>
  mods.flatMap((m) => [m, ...all(m.value.modules ?? []), ...(m.value.branches ?? []).flatMap((b) => all(b.modules)), ...all(m.value.default ?? [])]);

const CELL = { provider: "google", model: "pro" } as const;
const WRITERS: Record<string, DAG> = {
  "cold-whatsapp-outreach": buildColdWhatsappOutreachDag(),
  "form-meeting-booking": buildFormMeetingBookingDag(),
  "ai-lead-proposal": buildAiLeadProposalDag(),
  "ai-meeting-booking": buildAiMeetingBookingDag(CELL),
  "offer-document-reply": buildOfferDocumentReplyDag(CELL),
  "follow-up-proactive": buildFollowUpProactiveDag(),
  "follow-up-reactive": buildFollowUpReactiveDag({ readFigures: false }),
  "client-check-in": buildClientCheckInDag(),
  "founder-hello": buildFounderHelloDag(),
};

describe("every writer's person-thread read carries the settled-thread wait (conversion time)", () => {
  for (const [name, dag] of Object.entries(WRITERS)) {
    it(name, () => {
      const timelineIds = new Set(dag.nodes.filter(readsPersonThread).map((n) => n.id.replace(/-/g, "_")));
      expect(timelineIds.size).toBeGreaterThan(0);
      const flow = dagToOpenFlow(dag, name) as unknown as { value: { modules: Mod[] } };
      const mods = all(flow.value.modules);
      for (const id of timelineIds) {
        const mod = mods.find((m) => m.id === id);
        expect(mod, id).toBeDefined();
        expect(mod!.value.input_transforms?.pollWhile).toEqual({ type: "static", value: SETTLED_THREAD_WAIT });
      }
      for (const m of mods.filter((m) => !timelineIds.has(m.id))) {
        expect(m.value.input_transforms?.pollWhile?.value, m.id).not.toEqual(SETTLED_THREAD_WAIT);
      }
    });
  }
});
