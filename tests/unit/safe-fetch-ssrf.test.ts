import { describe, it, expect, afterAll, beforeAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readBookingSlotsCode } from "../../src/lib/booking-slots.js";
import {
  guardedFetch,
  publicFetch,
  isPublicAddress,
  PublicUrlRefusedError,
  PublicBodyTooLargeError,
  type Resolver,
  type Transport,
} from "../../src/lib/safe-fetch.js";

// SSRF-1127: an offer's booking link (customer data) was fetched by the AI answerer with the global fetch, redirects
// followed, and the status echoed into the AI's prompt. Every booking-link fetch now goes through the public-only fetch.

type Main = (u: string, tz: string, f: unknown) => Promise<Record<string, unknown>>;
let main: Main;
beforeAll(async () => {
  main = ((await import(`data:text/javascript,${encodeURIComponent(readBookingSlotsCode())}`)) as { main: Main }).main;
});

/** A resolver mapping a few test names; everything else is a public address. */
const resolver: Resolver = async (host) => {
  if (host.endsWith(".nip.io")) {
    const ip = host.replace(/\.nip\.io$/, "");
    return [{ address: ip, family: 4 }];
  }
  return [{ address: "93.184.215.14", family: 4 }];
};

function recordingTransport(answer: (url: URL) => Response): { transport: Transport; hits: string[] } {
  const hits: string[] = [];
  return {
    hits,
    transport: async (hop) => {
      hits.push(`${hop.url.href} @ ${hop.address}`);
      return answer(hop.url);
    },
  };
}

const PRIVATE_URLS = [
  "http://127.0.0.1:2019/config/",
  "http://localhost:8080/",
  "http://key-service:8080/keys",
  "http://10.0.0.5/",
  "http://172.17.0.1:2019/config/",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::1]/",
  "http://[::ffff:7f00:1]/",
  "http://127.0.0.1.nip.io:2019/config/",
  "http://172.17.0.1.nip.io:2019/config/",
  "http://169.254.169.254.nip.io/latest/meta-data/",
  "http://2130706433/", // decimal 127.0.0.1
  "http://0177.0.0.1/", // octal 127.0.0.1
  "http://62.83.93.230.nip.io/", // our own box
];

describe("guardedFetch refuses every non-public target before connecting (SSRF-1127)", () => {
  for (const url of PRIVATE_URLS) {
    it(`refuses ${url}`, async () => {
      const { transport, hits } = recordingTransport(() => new Response("internal"));
      await expect(guardedFetch({ resolve: resolver, transport })(url)).rejects.toBeInstanceOf(PublicUrlRefusedError);
      expect(hits).toEqual([]);
    });
  }

  it("refuses a public URL that 302-redirects to a private address, and never dials the private hop", async () => {
    const { transport, hits } = recordingTransport((u) =>
      u.hostname === "booking.example.com"
        ? new Response(null, { status: 302, headers: { location: "http://127.0.0.1.nip.io:2019/config/" } })
        : new Response("internal"),
    );
    await expect(guardedFetch({ resolve: resolver, transport })("https://booking.example.com/r")).rejects.toBeInstanceOf(PublicUrlRefusedError);
    expect(hits).toEqual(["https://booking.example.com/r @ 93.184.215.14"]);
  });

  it("refuses non-http schemes", async () => {
    const { transport, hits } = recordingTransport(() => new Response("x"));
    await expect(guardedFetch({ resolve: resolver, transport })("file:///etc/passwd")).rejects.toBeInstanceOf(PublicUrlRefusedError);
    await expect(guardedFetch({ resolve: resolver, transport })("gopher://example.com/")).rejects.toBeInstanceOf(PublicUrlRefusedError);
    expect(hits).toEqual([]);
  });

  it("a public https URL still works, its redirect to another public host followed", async () => {
    const { transport, hits } = recordingTransport((u) =>
      u.pathname === "/start"
        ? new Response(null, { status: 302, headers: { location: "https://cdn.example.org/page" } })
        : new Response("<html>leadconnectorhq</html>", { status: 200 }),
    );
    const res = await guardedFetch({ resolve: resolver, transport })("https://booking.example.com/start");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("leadconnectorhq");
    expect(hits).toHaveLength(2);
  });

  it("caps the body", async () => {
    const { transport } = recordingTransport(() => new Response("x".repeat(2048)));
    await expect(guardedFetch({ resolve: resolver, transport, maxBytes: 1024 })("https://booking.example.com/")).rejects.toBeInstanceOf(PublicBodyTooLargeError);
  });

  it("isPublicAddress: private spellings are not public, a public one is", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.17.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "::ffff:127.0.0.1", "fd00::1", "fe80::1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::"]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
    expect(isPublicAddress("93.184.215.14")).toBe(true);
    expect(isPublicAddress("2606:4700::1111")).toBe(true);
  });
});

describe("the booking-slots reader never reaches our network through a customer's booking link (SSRF-1127)", () => {
  let server: http.Server;
  let port = 0;
  let hits = 0;
  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html>leadconnectorhq calendarId \"AAAAAAAAAAAAAAAAAAAA\"</html>");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("a booking link on 127.0.0.1 is refused with a named reason, the local server never hit (real transport)", async () => {
    const out = await main(`http://127.0.0.1:${port}/book`, "UTC", guardedFetch());
    expect(out).toMatchObject({ degraded: true, degradedReason: "booking_page_fetch_failed: booking_url_not_public", slots: [] });
    expect(hits).toBe(0);
  });

  it("a booking link on localhost / a docker name is refused the same way", async () => {
    for (const u of [`http://localhost:${port}/`, "http://key-service:8080/keys", "http://[::1]/"]) {
      const out = await main(u, "UTC", guardedFetch());
      expect(out.degradedReason).toBe("booking_page_fetch_failed: booking_url_not_public");
    }
    expect(hits).toBe(0);
  });

  it("a public booking page that redirects inside is refused, the status of the inside never surfaces", async () => {
    const { transport, hits: dialled } = recordingTransport((u) =>
      u.hostname === "book.client.example"
        ? new Response(null, { status: 302, headers: { location: `http://127.0.0.1:${port}/` } })
        : new Response("never"),
    );
    const out = await main("https://book.client.example/meet", "UTC", guardedFetch({ resolve: resolver, transport }));
    expect(out.degradedReason).toBe("booking_page_fetch_failed: booking_url_not_public");
    expect(dialled).toEqual(["https://book.client.example/meet @ 93.184.215.14"]);
    expect(hits).toBe(0);
  });

  it("a non-http booking link is refused before any fetch", async () => {
    const out = await main("file:///etc/passwd", "UTC", guardedFetch());
    expect(out.degradedReason).toBe("booking_url_not_public");
  });

  it("the reader refuses to run on the global fetch", async () => {
    await expect(main("https://calendly.com/a/b", "UTC", undefined)).rejects.toThrow(/guarded fetch/);
  });

  it("a public GoHighLevel page still reads its slots", async () => {
    const { transport } = recordingTransport((u) => {
      if (u.hostname === "book.client.example") {
        return new Response('<html>leadconnectorhq "calendarId":"x","AbCdEfGhIjKlMnOpQrSt"</html>');
      }
      return new Response(JSON.stringify({ "2030-01-02": { slots: ["2030-01-02T10:00:00+00:00"] }, traceId: "t" }), {
        headers: { "content-type": "application/json" },
      });
    });
    const out = await main("https://book.client.example/meet", "UTC", guardedFetch({ resolve: resolver, transport }));
    expect(out).toMatchObject({ degraded: false, slots: ["2030-01-02T10:00:00+00:00"], calendarId: "AbCdEfGhIjKlMnOpQrSt" });
  });
});

describe("publicFetch drops credentials on a cross-origin redirect", () => {
  it("authorization never follows to another origin", async () => {
    const seen: Array<Record<string, string>> = [];
    const transport: Transport = async (hop, req) => {
      seen.push(req.headers);
      return hop.url.hostname === "a.example.com"
        ? new Response(null, { status: 302, headers: { location: "https://b.example.com/" } })
        : new Response("ok");
    };
    await publicFetch("https://a.example.com/", { headers: { authorization: "Bearer x" }, resolve: resolver, transport });
    expect(seen[0].authorization).toBe("Bearer x");
    expect(seen[1].authorization).toBeUndefined();
  });
});
