import { describe, it, expect } from "vitest";
import {
  resolveObjective,
  extractOutcomeCount,
  rescoreForObjective,
  EMPTY_EMAIL_STATS,
  type WorkflowScore,
} from "../../src/lib/workflow-scoring.js";

const makeEmailStats = (overrides: Partial<typeof EMPTY_EMAIL_STATS> = {}) => ({
  ...EMPTY_EMAIL_STATS,
  ...overrides,
});

function makeScore(opts: {
  totalCost: number;
  completedRuns: number;
  transactional?: Partial<typeof EMPTY_EMAIL_STATS>;
  broadcast?: Partial<typeof EMPTY_EMAIL_STATS>;
}): WorkflowScore {
  return {
    workflow: {
      id: "wf-1",
      slug: "test-wf",
      name: "Test Workflow",
      dynastyName: "Test",
      dynastySlug: "test",
      version: 1,
      createdForBrandId: null,
      featureSlug: "feature-a",
      signature: "abc",
      signatureName: "alpha",
    } as WorkflowScore["workflow"],
    totalCost: opts.totalCost,
    totalOutcomes: 0,
    costPerOutcome: null,
    completedRuns: opts.completedRuns,
    emailStats: {
      transactional: makeEmailStats(opts.transactional),
      broadcast: makeEmailStats(opts.broadcast),
    },
  };
}

describe("resolveObjective", () => {
  it("resolves 'replies' alias to 'emailsReplied'", () => {
    expect(resolveObjective("replies")).toBe("emailsReplied");
  });

  it("resolves 'clicks' alias to 'emailsClicked'", () => {
    expect(resolveObjective("clicks")).toBe("emailsClicked");
  });

  it("passes through native stats keys unchanged", () => {
    expect(resolveObjective("emailsOpened")).toBe("emailsOpened");
    expect(resolveObjective("emailsSent")).toBe("emailsSent");
    expect(resolveObjective("recipients")).toBe("recipients");
  });
});

describe("extractOutcomeCount", () => {
  it("extracts emailsReplied from transactional + broadcast", () => {
    const stats = {
      transactional: makeEmailStats({ replied: 5 }),
      broadcast: makeEmailStats({ replied: 3 }),
    };
    expect(extractOutcomeCount("emailsReplied", stats)).toBe(8);
  });

  it("extracts emailsClicked from transactional + broadcast", () => {
    const stats = {
      transactional: makeEmailStats({ clicked: 10 }),
      broadcast: makeEmailStats({ clicked: 7 }),
    };
    expect(extractOutcomeCount("emailsClicked", stats)).toBe(17);
  });

  it("extracts emailsOpened", () => {
    const stats = {
      transactional: makeEmailStats({ opened: 20 }),
      broadcast: makeEmailStats({ opened: 15 }),
    };
    expect(extractOutcomeCount("emailsOpened", stats)).toBe(35);
  });

  it("extracts emailsSent", () => {
    const stats = {
      transactional: makeEmailStats({ sent: 100 }),
      broadcast: makeEmailStats({ sent: 50 }),
    };
    expect(extractOutcomeCount("emailsSent", stats)).toBe(150);
  });

  it("extracts emailsDelivered", () => {
    const stats = {
      transactional: makeEmailStats({ delivered: 90 }),
      broadcast: makeEmailStats({ delivered: 45 }),
    };
    expect(extractOutcomeCount("emailsDelivered", stats)).toBe(135);
  });

  it("throws for unknown stats key", () => {
    const stats = {
      transactional: makeEmailStats(),
      broadcast: makeEmailStats(),
    };
    expect(() => extractOutcomeCount("unknownMetric", stats)).toThrow(
      'Unknown objective metric: "unknownMetric"'
    );
  });
});

describe("rescoreForObjective", () => {
  it("re-computes outcomes and costPerOutcome for a different metric", () => {
    const score = makeScore({
      totalCost: 1000,
      completedRuns: 5,
      transactional: { replied: 2, clicked: 10 },
      broadcast: { replied: 3, clicked: 5 },
    });

    const rescoredReplies = rescoreForObjective([score], "emailsReplied");
    expect(rescoredReplies[0].totalOutcomes).toBe(5); // 2 + 3
    expect(rescoredReplies[0].costPerOutcome).toBe(200); // 1000 / 5

    const rescoredClicks = rescoreForObjective([score], "emailsClicked");
    expect(rescoredClicks[0].totalOutcomes).toBe(15); // 10 + 5
    expect(rescoredClicks[0].costPerOutcome).toBeCloseTo(66.67, 1); // 1000 / 15
  });

  it("resolves legacy aliases", () => {
    const score = makeScore({
      totalCost: 500,
      completedRuns: 3,
      transactional: { replied: 5 },
      broadcast: { replied: 5 },
    });

    const rescored = rescoreForObjective([score], "replies");
    expect(rescored[0].totalOutcomes).toBe(10);
    expect(rescored[0].costPerOutcome).toBe(50);
  });

  it("returns null costPerOutcome when no outcomes", () => {
    const score = makeScore({
      totalCost: 1000,
      completedRuns: 5,
      transactional: { opened: 0 },
      broadcast: { opened: 0 },
    });

    const rescored = rescoreForObjective([score], "emailsOpened");
    expect(rescored[0].totalOutcomes).toBe(0);
    expect(rescored[0].costPerOutcome).toBeNull();
  });

  it("does not mutate the original scores", () => {
    const score = makeScore({
      totalCost: 1000,
      completedRuns: 5,
      transactional: { replied: 10 },
    });
    score.totalOutcomes = 99;
    score.costPerOutcome = 99;

    rescoreForObjective([score], "emailsReplied");

    expect(score.totalOutcomes).toBe(99);
    expect(score.costPerOutcome).toBe(99);
  });

  it("ranks differently depending on metric", () => {
    const scoreA = makeScore({
      totalCost: 100,
      completedRuns: 5,
      transactional: { replied: 10, clicked: 1 },
    });
    scoreA.workflow = { ...scoreA.workflow, id: "wf-a", slug: "wf-a" } as WorkflowScore["workflow"];

    const scoreB = makeScore({
      totalCost: 100,
      completedRuns: 5,
      transactional: { replied: 1, clicked: 10 },
    });
    scoreB.workflow = { ...scoreB.workflow, id: "wf-b", slug: "wf-b" } as WorkflowScore["workflow"];

    // By replies: A is better (cost 10 vs 100)
    const byReplies = rescoreForObjective([scoreA, scoreB], "emailsReplied");
    expect(byReplies[0].costPerOutcome).toBe(10); // A
    expect(byReplies[1].costPerOutcome).toBe(100); // B

    // By clicks: B is better (cost 10 vs 100)
    const byClicks = rescoreForObjective([scoreA, scoreB], "emailsClicked");
    expect(byClicks[0].costPerOutcome).toBe(100); // A
    expect(byClicks[1].costPerOutcome).toBe(10); // B
  });
});
