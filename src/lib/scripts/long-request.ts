/**
 * One HTTP request that may wait as long as its caller says (MIGRATE-1105 S1, 2026-11-09): Node's `fetch` gives up
 * after 5 minutes without the response headers (undici's built-in `headersTimeout`), whatever `AbortSignal` the
 * caller set, so a writer that thinks for 6 minutes (GLM on a long thread) failed every run with `fetch failed`
 * while chat-service went on and answered. `node:http` has no such hidden cut: the only bound is `timeoutMs`.
 * Same surface as the `fetch` answers its callers read (`ok`, `status`, `text()`).
 */
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export interface LongResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export function longRequest(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string; signal?: unknown },
  timeoutMs = 600_000,
): Promise<LongResponse> {
  const u = new URL(url);
  const send = u.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(u, { method: init.method ?? "GET", headers: { ...(init.headers ?? {}), ...(init.body !== undefined ? { "content-length": String(Buffer.byteLength(init.body)) } : {}) } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        resolve({ ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) as unknown });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`${init.method ?? "GET"} ${u.pathname} gave no answer within ${timeoutMs / 1000} s`)), timeoutMs);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
