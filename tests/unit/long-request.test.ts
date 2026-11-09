import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { longRequest } from "../../src/lib/scripts/long-request.js";

// 2026-11-09: GLM took over 5 minutes to answer a long thread; Node's fetch gave up at its hidden 5-minute headers
// cut and every answering run failed `fetch failed`. longRequest waits exactly as long as its caller says.
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${(server!.address() as AddressInfo).port}`)));
}

describe("longRequest", () => {
  it("posts the body with its headers and reads a slow answer whole", async () => {
    const base = await listen((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => setTimeout(() => res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ got: JSON.parse(body), key: req.headers["x-api-key"] })), 300));
    });
    const res = await longRequest(`${base}/complete`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": "k" }, body: JSON.stringify({ a: 1 }) });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ got: { a: 1 }, key: "k" });
  });

  it("a non-2xx is an answer, and only its own timeout ends the wait", async () => {
    const base = await listen((_req, res) => res.writeHead(409).end('{"code":"x"}'));
    const res = await longRequest(`${base}/x`, { method: "GET" });
    expect(res.ok).toBe(false);
    expect(await res.text()).toBe('{"code":"x"}');
    const silent = await listen(() => {});
    await expect(longRequest(`${silent}/y`, { method: "GET" }, 200)).rejects.toThrow(/no answer within 0.2 s/);
  });
});
