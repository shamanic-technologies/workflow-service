import { describe, it, expect } from "vitest";
import { validateDAG } from "../../src/lib/dag-validator.js";
import { extractBodyFields } from "../../src/lib/validate-workflow-endpoints.js";
import { AI_INSTANT_CALL_PIPE_ID, buildAiInstantCallDag } from "../../src/lib/ai-instant-call-dag.js";

describe("the workflow of the AI Instant Call pipe (owner 2026-10-11: every pipe runs a workflow)", () => {
  it("lives on the Positive reply -> Booking call pipe", () => {
    expect(AI_INSTANT_CALL_PIPE_ID).toBe("ai-instant-call|conversation_to_booking_call");
  });

  it("its one step is the call to the rep (twilio-service), a valid DAG stating the call's required fields", () => {
    const dag = buildAiInstantCallDag();
    expect(validateDAG(dag).valid).toBe(true);
    expect(dag.nodes).toHaveLength(1);
    const [node] = dag.nodes;
    expect(node.config).toEqual({ service: "twilio", method: "POST", path: "/calls" });
    expect(extractBodyFields(node)).toEqual(expect.arrayContaining(["to", "reply"]));
  });
});
