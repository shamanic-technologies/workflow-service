import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateSource } from "../../src/lib/scripts/sandbox.js";
import { addFollowUpNextMessage } from "../../src/lib/scripts/follow-up-next-message.js";

// PERSON-ALREADY-EMAILED-1125: the lead follow-up writer (live v3, byte for byte) has its licensing sentence restated;
// nothing else of its code moves.
const STORED = readFileSync(join(__dirname, "../fixtures/stored-scripts/follow-up-next-message/message_written__dy_follow_up_due.v3.ts.txt"), "utf8");
const NEXT = addFollowUpNextMessage(STORED);

describe("message_written/dy_follow_up_due: the next message of the thread", () => {
  it("replaces only the licensing sentence (plus the mark), reads and calls the same", async () => {
    const before = STORED.split("\n");
    const after = NEXT.split("\n");
    expect(after.length).toBe(before.length + 1);
    const changed = after.slice(1).map((l, i) => [before[i], l]).filter(([b, a]) => b !== a);
    expect(changed).toHaveLength(2);
    expect(changed[0][0]).toContain("Never a reminder of an earlier message");
    expect(changed[0][1]).not.toContain("earn a reply on its own");
    expect(changed[0][1]).toContain("never introduce us, what we do or our offer as if they had never heard of it");
    expect(changed[1][0]).toContain("from the same mailbox, so never re-introduce us");
    expect(changed[1][1]).toContain("a new email from someone of our team they have not heard from yet");
    expect(changed[1][1]).not.toContain("from the same mailbox, so");
    const [b, a] = [await validateSource(STORED), await validateSource(NEXT)];
    expect(a.materials).toEqual(b.materials);
    expect(a.vendors).toEqual(b.vendors);
    expect(() => addFollowUpNextMessage(NEXT)).toThrow(/already/);
  }, 30_000);
});
