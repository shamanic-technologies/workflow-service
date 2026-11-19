import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMaterials, validateSource } from "../../src/lib/scripts/sandbox.js";
import { COPILOT_ANCHORS, copilotSplitTactics, requestedOf, splitCopilotWriter, type CopilotSplitDynasty } from "../../src/lib/scripts/copilot-writer-split.js";
import { writesToPerson } from "../../src/lib/scripts/vendors.js";

// WRITER-SENDER-SPLIT-1119-COPILOT: the stored client check-in and brand team answer (paid_client v3, byte for byte as
// production stores them) are cut into their writer (prompt, Copilot lead turn, decision) and their sender. The halves
// are proven call by call on each dynasty's recorded cases by scripts/prove-copilot-writer-split.mjs.
const STORED: Record<CopilotSplitDynasty, string> = {
  dy_client_check_in: readFileSync(join(__dirname, "../fixtures/client-check-in-stored-v3.js"), "utf8"),
  dy_brand_team: readFileSync(join(__dirname, "../fixtures/brand-team-stored-v3.js"), "utf8"),
};

describe.each(Object.keys(STORED) as CopilotSplitDynasty[])("splitCopilotWriter %s", (dynasty) => {
  const halves = splitCopilotWriter(STORED[dynasty], dynasty);

  it("moves the prompt, the turn plan, the Copilot's turn and the decision to the writer", () => {
    for (const anchor of [COPILOT_ANCHORS.compose, COPILOT_ANCHORS.plan, COPILOT_ANCHORS.draft, COPILOT_ANCHORS.finalize]) {
      expect(halves.writer.split(anchor).length - 1, anchor).toBe(1);
    }
    expect(halves.sender).not.toContain(COPILOT_ANCHORS.draft);
    expect(halves.sender).not.toContain(COPILOT_ANCHORS.compose);
    expect(halves.sender).toContain('ctx.get("message_written")');
    expect(halves.writer).not.toContain("results.send_whatsapp");
    expect(halves.writer).not.toContain("results.send_email");
  });

  it("the writer reads only what its sender hands; the sender reads only its writer", () => {
    expect(readMaterials(halves.writer)).toEqual([requestedOf(dynasty)]);
    expect(readMaterials(halves.sender)).toEqual(["message_written"]);
    expect(writesToPerson(halves.sender)).toBe(true);
  });

  it("both halves are valid script sources", async () => {
    await expect(validateSource(halves.writer)).resolves.toMatchObject({ materials: [requestedOf(dynasty)] });
    await expect(validateSource(halves.sender)).resolves.toMatchObject({ materials: ["message_written"] });
  });

  it("refuses an already split code", () => {
    expect(() => splitCopilotWriter(halves.sender, dynasty)).toThrow();
  });

  it("the sender keeps its tactics and asks its writer", () => {
    const t = copilotSplitTactics({ channel: "ai-follow-up-email", recorded_by: "sender", relationships: "current_client" });
    expect(t.sender).toEqual({ channel: "ai-follow-up-email", recorded_by: "sender", relationships: "current_client", asks: ["message_written"] });
    expect(t.writer.personFields).toBeDefined();
  });
});
