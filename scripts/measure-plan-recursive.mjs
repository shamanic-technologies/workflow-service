#!/usr/bin/env node
/**
 * PLAN-RECURSIVE-PER-ENGINE-1124, HOLD check (read only: nothing written, no proof started, no pick drawn).
 *
 * For every ongoing campaign x Engine it dispatches, the scripts the Rating may draw BEFORE the change (a script runs
 * only when the run holds every Unit it reads or asks for it, and its stated channel is the campaign's) vs AFTER (a
 * Unit the run lacks is asked of its Engine, recursively), computed by the build passed as the first argument
 * (`/app/dist`). Input on stdin: JSON lines `{campaignId, orgId, outcome, fromOutcome, featureSlug}`.
 *
 *   docker cp scripts/measure-plan-recursive.mjs <container>:/app/scripts/
 *   ... | docker exec -i <container> node /app/scripts/measure-plan-recursive.mjs /app/dist
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dist = process.argv[2] ?? "/app/dist";
const { candidatesOf, servesChannel } = await import(pathToFileURL(`${dist}/lib/scripts/engine.js`).href);
const { asksOf } = await import(pathToFileURL(`${dist}/lib/scripts/sandbox.js`).href);
const { db, sql } = await import(pathToFileURL(`${dist}/db/index.js`).href);

const rows = readFileSync(0, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const out = [];
for (const r of rows) {
  const servable = r.fromOutcome && r.fromOutcome !== "start" ? [r.fromOutcome] : [];
  try {
    const after = await candidatesOf(db, { outcome: r.outcome, servable, channel: r.featureSlug ?? null, campaignId: r.campaignId, orgId: r.orgId });
    // BEFORE: the same candidates narrowed by the old rules (every Unit held or asked, the stated channel the campaign's).
    const before = after.filter((s) => {
      const asked = asksOf(s);
      if (!(s.materials ?? []).every((m) => servable.includes(m) || asked.includes(m))) return false;
      const ch = s.tactics?.channel;
      return typeof ch !== "string" || ch === (r.featureSlug ?? null);
    });
    const b = new Set(before.map((s) => s.dynasty));
    const serves = await servesChannel(db, r.outcome, r.featureSlug ?? null, r.campaignId);
    out.push({ ...r, before: [...b].sort(), after: after.map((s) => s.dynasty).sort(), gained: after.map((s) => s.dynasty).filter((d) => !b.has(d)).sort(), servesChannel: serves });
  } catch (e) {
    out.push({ ...r, error: e instanceof Error ? e.message : String(e) });
  }
}
for (const o of out) console.log(JSON.stringify(o));
await sql.end();
