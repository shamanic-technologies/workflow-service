import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isAmbiguousWindmillDispatchError,
  WindmillClient,
  WindmillTransportError,
} from "../../src/lib/windmill-client.js";

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

describe("WindmillClient transport classification", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function transportError(code: string): TypeError {
    const err = new TypeError("fetch failed");
    Object.defineProperty(err, "cause", {
      value: { code },
      enumerable: false,
    });
    return err;
  }

  it("retries safe GET job polling once on transient transport failure", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(transportError("UND_ERR_SOCKET"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "job-1", running: false, success: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    const client = new WindmillClient({
      baseUrl: "https://windmill.example.com",
      token: "tok",
      workspace: "prod",
    });

    const job = await client.getJob("job-1");

    expect(job.id).toBe("job-1");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not retry ambiguous POST runFlow socket-close failures", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(transportError("UND_ERR_SOCKET"));

    const client = new WindmillClient({
      baseUrl: "https://windmill.example.com",
      token: "tok",
      workspace: "prod",
    });

    await expect(client.runFlow("f/workflows/test", {})).rejects.toMatchObject({
      name: "WindmillTransportError",
      kind: "socket_closed",
      dispatchAmbiguous: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("classifies connect timeout POST failures as not dispatched", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      transportError("UND_ERR_CONNECT_TIMEOUT"),
    );

    const client = new WindmillClient({
      baseUrl: "https://windmill.example.com",
      token: "tok",
      workspace: "prod",
    });

    try {
      await client.runFlow("f/workflows/test", {});
      throw new Error("expected runFlow to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WindmillTransportError);
      expect(isAmbiguousWindmillDispatchError(err)).toBe(false);
      expect((err as WindmillTransportError).kind).toBe("connect_timeout");
    }
  });
});
