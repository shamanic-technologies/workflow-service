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

/**
 * Builds sourceMetrics from email stats, mirroring the production emailStatsToMetrics helper.
 */
function buildSourceMetrics(
  transactional: typeof EMPTY_EMAIL_STATS,
  broadcast: typeof EMPTY_EMAIL_STATS,
  extra?: Record<string, number>,
): Record<string, number> {
  const EMAIL_KEY_TO_FIELD: Record<string, keyof typeof EMPTY_EMAIL_STATS> = {
    emailsSent: "sent",
    emailsDelivered: "delivered",
    emailsOpened: "opened",
    emailsClicked: "clicked",
    emailsReplied: "replied",
    emailsBounced: "bounced",
    recipients: "recipients",
  };
  const metrics: Record<string, number> = {};
  for (const [statsKey, field] of Object.entries(EMAIL_KEY_TO_FIELD)) {
    metrics[statsKey] = transactional[field] + broadcast[field];
  }
  if (extra) Object.assign(metrics, extra);
  return metrics;
}

function makeScore(opts: {
  totalCost: number;
  completedRuns: number;
  transactional?: Partial<typeof EMPTY_EMAIL_STATS>;
  broadcast?: Partial<typeof EMPTY_EMAIL_STATS>;
  extraMetrics?: Record<string, number>;
}): WorkflowScore {
  const transactional = makeEmailStats(opts.transactional);
  const broadcast = makeEmailStats(opts.broadcast);
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
    emailStats: { transactional, broadcast },
    sourceMetrics: buildSourceMetrics(transactional, broadcast, opts.extraMetrics),
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
  it("extracts emailsReplied from sourceMetrics", () => {
    const metrics = buildSourceMetrics(
      makeEmailStats({ replied: 5 }),
      makeEmailStats({ replied: 3 }),
    );
    expect(extractOutcomeCount("emailsReplied", metrics)).toBe(8);
  });

  it("extracts emailsClicked from sourceMetrics", () => {
    const metrics = buildSourceMetrics(
      makeEmailStats({ clicked: 10 }),
      makeEmailStats({ clicked: 7 }),
    );
    expect(extractOutcomeCount("emailsClicked", metrics)).toBe(17);
  });

  it("extracts emailsOpened", () => {
    const metrics = buildSourceMetrics(
      makeEmailStats({ opened: 20 }),
      makeEmailStats({ opened: 15 }),
    );
    expect(extractOutcomeCount("emailsOpened", metrics)).toBe(35);
  });

  it("extracts emailsSent", () => {
    const metrics = buildSourceMetrics(
      makeEmailStats({ sent: 100 }),
      makeEmailStats({ sent: 50 }),
    );
    expect(extractOutcomeCount("emailsSent", metrics)).toBe(150);
  });

  it("extracts emailsDelivered", () => {
    const metrics = buildSourceMetrics(
      makeEmailStats({ delivered: 90 }),
      makeEmailStats({ delivered: 45 }),
    );
    expect(extractOutcomeCount("emailsDelivered", metrics)).toBe(135);
  });

  it("extracts non-email metrics (leadsServed, outletsDiscovered)", () => {
    const metrics = { leadsServed: 42, outletsDiscovered: 7 };
    expect(extractOutcomeCount("leadsServed", metrics)).toBe(42);
    expect(extractOutcomeCount("outletsDiscovered", metrics)).toBe(7);
  });

  it("throws for unknown stats key", () => {
    const metrics = buildSourceMetrics(makeEmailStats(), makeEmailStats());
    expect(() => extractOutcomeCount("unknownMetric", metrics)).toThrow(
      'Metric "unknownMetric" not found in source metrics'
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

  it("works with non-email source metrics (leadsServed)", () => {
    const score = makeScore({
      totalCost: 2000,
      completedRuns: 10,
      extraMetrics: { leadsServed: 40, leadsContacted: 20 },
    });

    const rescored = rescoreForObjective([score], "leadsServed");
    expect(rescored[0].totalOutcomes).toBe(40);
    expect(rescored[0].costPerOutcome).toBe(50); // 2000 / 40
  });
});
