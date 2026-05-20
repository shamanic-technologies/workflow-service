import { describe, it, expect, vi, afterEach } from "vitest";
import { WindmillClient } from "../../src/lib/windmill-client.js";

describe("WindmillClient.setGlobalSetting", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs to /api/settings/global/{key} with no workspace prefix", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));

    const client = new WindmillClient({
      baseUrl: "https://windmill.example.com",
      token: "tok",
      workspace: "prod",
    });

    await client.setGlobalSetting("retention_period_secs", 604800);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://windmill.example.com/api/settings/global/retention_period_secs");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(init?.body).toBe(JSON.stringify({ value: 604800 }));
  });

  it("strips trailing slash from baseUrl", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("OK", { status: 200 }));

    const client = new WindmillClient({
      baseUrl: "https://windmill.example.com/",
      token: "tok",
    });

    await client.setGlobalSetting("retention_period_secs", 604800);

    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://windmill.example.com/api/settings/global/retention_period_secs",
    );
  });

  it("throws with status + body on non-2xx response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("forbidden: requires superadmin", {
        status: 403,
        statusText: "Forbidden",
      }),
    );

    const client = new WindmillClient({
      baseUrl: "https://windmill.example.com",
      token: "tok",
    });

    await expect(
      client.setGlobalSetting("retention_period_secs", 604800),
    ).rejects.toThrow(/403.*Forbidden.*forbidden: requires superadmin/);
  });
});
