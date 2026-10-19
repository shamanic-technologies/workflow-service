import { describe, expect, it } from "vitest";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import type { DAG } from "../../src/lib/dag-validator.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildFormMeetingBookingDag } from "../../src/lib/form-meeting-booking-dag.js";
import { buildIndustryUpdateVideoDag } from "../../src/lib/industry-update-video-dag.js";
import { buildAiInstantCallDag } from "../../src/lib/ai-instant-call-dag.js";
import { buildEmailSendingDag } from "../../src/lib/email-sending-dag.js";
import { buildAiLeadProposalDag } from "../../src/lib/ai-lead-proposal-dag.js";
import { buildAiMeetingBookingDag } from "../../src/lib/ai-meeting-booking-dag.js";
import { buildSourcingDag } from "../../src/lib/sourcing-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";

/**
 * LLM-SPEND-NO-SEND-1016: a run reports its end to campaign-service ONCE. An `/end-run` node that is the target of
 * a branch arm AND of a node inside another arm is a convergence point, so the converter emits it at TOP LEVEL and
 * it runs on EVERY run, after whichever end-run the branch already called. On cold-whatsapp-outreach that second
 * call said "normal run" right after "idle", so campaign-service re-dispatched the campaign every ~14 seconds
 * (5,274 runs in a day for 2 people).
 */
type Mod = { id: string; value: { type: string; branches?: { modules: Mod[] }[]; default?: Mod[] } };

const CELL = { provider: "google", model: "pro" } as const;
const DAGS: Record<string, DAG> = {
  "cold-whatsapp-outreach": buildColdWhatsappOutreachDag(),
  "form-meeting-booking": buildFormMeetingBookingDag(),
  "industry-update-video": buildIndustryUpdateVideoDag(),
  "ai-instant-call": buildAiInstantCallDag(),
  "ai-instant-call-email-only": buildAiInstantCallDag({ emailRepliesOnly: true }),
  "email-sending": buildEmailSendingDag(),
  "ai-lead-proposal": buildAiLeadProposalDag(),
  "ai-meeting-booking": buildAiMeetingBookingDag(CELL),
  "offer-document-reply": buildOfferDocumentReplyDag(CELL),
  sourcing: buildSourcingDag(),
  "follow-up-proactive": buildFollowUpProactiveDag(),
  "follow-up-reactive": buildFollowUpReactiveDag({ readFigures: false }),
  "follow-up-reactive-figures": buildFollowUpReactiveDag({ readFigures: true }),
};

const moduleId = (nodeId: string) => nodeId.replace(/-/g, "_");

function endRunModuleIds(dag: DAG): Set<string> {
  return new Set(
    dag.nodes
      .filter((n) => n.id !== dag.onError && (n.config as { path?: string } | undefined)?.path === "/end-run")
      .map((n) => moduleId(n.id)),
  );
}

function inBranches(mods: Mod[]): Mod[] {
  return mods.flatMap((m) => [
    ...(m.value.branches ?? []).flatMap((b) => [...b.modules, ...inBranches(b.modules)]),
    ...(m.value.default ?? []).flatMap((d) => [d, ...inBranches([d])]),
  ]);
}

describe("every workflow DAG ends a run exactly once", () => {
  for (const [name, dag] of Object.entries(DAGS)) {
    it(`${name}: no top-level end-run runs after a branch that already ended the run`, () => {
      const ends = endRunModuleIds(dag);
      const top = dagToOpenFlow(dag, `${name}-test`).value.modules as Mod[];
      const topEnds = top.filter((m) => ends.has(m.id)).map((m) => m.id);
      const branchEnds = inBranches(top).filter((m) => ends.has(m.id)).map((m) => m.id);
      if (branchEnds.length > 0) expect({ name, topEnds }).toEqual({ name, topEnds: [] });
      expect(topEnds.length).toBeLessThanOrEqual(1);
    });
  }
});
