import { describe, expect, it } from "vitest";
import { newServedHold, noteDoorAnswer, releaseStatement, RELEASE_AFTER_FAILURE_MS } from "../../src/lib/scripts/failed-run-release.js";

const NOW = new Date("2026-11-26T15:26:59Z");
const served = { ok: true, data: { found: true, lead: { leadCampaignId: "row-1", brandIds: ["brand-1"] } } };

describe("a failed run gives its served follow-up back within the hour (FAILED-RUN-RELEASE-1126)", () => {
  it("states the date one hour out, with the failure as its reason", () => {
    const h = newServedHold();
    noteDoorAnswer(h, "lead.serve", served);
    const r = releaseStatement(h, "failed", "POST email-gateway/orgs/send failed (502): Upstream service error", NOW);
    expect(r).toEqual({
      params: { id: "row-1" },
      query: { brandId: "brand-1" },
      body: {
        nextFollowupAt: new Date(NOW.getTime() + RELEASE_AFTER_FAILURE_MS).toISOString(),
        reason: expect.stringContaining("Upstream service error"),
      },
    });
  });

  it("a stopped run is released too", () => {
    const h = newServedHold();
    noteDoorAnswer(h, "lead.serve", served);
    expect(releaseStatement(h, "stopped", "writer stopped", NOW)).not.toBeNull();
  });

  it("a run that sent or stated a date keeps what it left", () => {
    for (const door of ["email.send", "crm.whatsapp.send", "lead.followup_date.set", "lead.followup.record"]) {
      const h = newServedHold();
      noteDoorAnswer(h, "lead.serve", served);
      noteDoorAnswer(h, door, { ok: true, data: {} });
      expect(releaseStatement(h, "failed", "x", NOW)).toBeNull();
    }
  });

  it("a refused send leaves no date: still released", () => {
    const h = newServedHold();
    noteDoorAnswer(h, "lead.serve", served);
    noteDoorAnswer(h, "email.send", { ok: false, data: { error: "Upstream service error" } });
    expect(releaseStatement(h, "failed", "x", NOW)).not.toBeNull();
  });

  it("nobody served, or a made / unmade run: nothing touched", () => {
    const empty = newServedHold();
    noteDoorAnswer(empty, "lead.serve", { ok: true, data: { found: false } });
    expect(releaseStatement(empty, "failed", "x", NOW)).toBeNull();
    const h = newServedHold();
    noteDoorAnswer(h, "lead.serve", served);
    expect(releaseStatement(h, "made", null, NOW)).toBeNull();
    expect(releaseStatement(h, "unmade", "later", NOW)).toBeNull();
  });
});
