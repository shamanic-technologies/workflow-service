import { describe, it, expect } from "vitest";
import { mapGatewayStats } from "../../src/lib/stats-client.js";

describe("mapGatewayStats", () => {
  it("maps email-gateway prefixed fields (emailsOpened) to internal names", () => {
    const raw = {
      emailsSent: 42,
      emailsDelivered: 40,
      emailsOpened: 15,
      emailsClicked: 3,
      emailsReplied: 2,
      emailsBounced: 1,
      repliesUnsubscribe: 0,
      recipients: 42,
    };

    const result = mapGatewayStats(raw);

    expect(result).toEqual({
      sent: 42,
      delivered: 40,
      opened: 15,
      clicked: 3,
      replied: 2,
      bounced: 1,
      unsubscribed: 0,
      recipients: 42,
    });
  });

  it("defaults missing fields to 0", () => {
    const result = mapGatewayStats({});

    expect(result).toEqual({
      sent: 0,
      delivered: 0,
      opened: 0,
      clicked: 0,
      replied: 0,
      bounced: 0,
      unsubscribed: 0,
      recipients: 0,
    });
  });
});
