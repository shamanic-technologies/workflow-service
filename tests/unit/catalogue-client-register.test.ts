import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assignWorkflowToLeg, LegAssignmentError } from "../../src/lib/catalogue-client.js";

const ROW = {
  featureSlug: "ai-meeting-booking",
  legKey: "conversation_to_meeting_booked",
  workflowDynastySlug: "ai-meeting-booking-avior",
  state: "active",
  decidedBy: "workflow-service",
  decidedAt: "2026-10-10T17:00:00.000Z",
  note: "x",
};
const INPUT = {
  featureSlug: "ai-meeting-booking",
  legKey: "conversation_to_meeting_booked",
  workflowDynastySlug: "ai-meeting-booking-avior",
  decidedBy: "workflow-service (generated for user u-1)",
  note: "Generated for this pipe.",
};

describe("assignWorkflowToLeg -> features-service POST /internal/workflow-leg-assignments/register", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.FEATURES_SERVICE_URL = "http://features";
    process.env.FEATURES_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("posts the pipe id, the dynasty and registeredBy workflow-service", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ created: true, assignment: ROW, pipe: {} }), { status: 201 }));
    const row = await assignWorkflowToLeg(INPUT);
    expect(row.state).toBe("active");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://features/internal/workflow-leg-assignments/register");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      pipeId: "ai-meeting-booking|conversation_to_meeting_booked",
      workflowDynastySlug: "ai-meeting-booking-avior",
      registeredBy: "workflow-service",
      note: "workflow-service (generated for user u-1): Generated for this pipe.",
    });
  });

  it("accepts 200 created:false (already on the pipe, row untouched)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ created: false, assignment: ROW, pipe: {} }), { status: 200 }));
    await expect(assignWorkflowToLeg(INPUT)).resolves.toMatchObject({ workflowDynastySlug: "ai-meeting-booking-avior" });
  });

  it("throws LegAssignmentError on a refusal", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ reason: "workflow_dynasty_not_found" }), { status: 404 }));
    await expect(assignWorkflowToLeg(INPUT)).rejects.toBeInstanceOf(LegAssignmentError);
  });
});
