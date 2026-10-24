/**
 * WF-SHORT-LINE-1023: keeps every pipe's short lines true (see `sibling-line.ts`). A pipe's siblings are the dynasties
 * features-service assigns to it (any state: the Research page lists deprecated ones too); its `siblingsKey` hashes
 * each sibling's newest version (id + DAG signature), whether it runs, and the rules version. When the key moved (a new sibling, an
 * upgrade, a leg move, a rule change), one model call writes the whole pipe's lines again; otherwise nothing is read
 * beyond the key. A pipe with one workflow has no line (nothing to set apart). A pipe the model could not describe
 * within three tries serves no line (never a stale one) and is retried six hours later, loudly logged.
 *
 * Rides traffic like PeriodicCleanup (no timer of its own): `maybeRun()` from every workflow write and run dispatch,
 * at most once per `minIntervalMs`, plus one sweep shortly after boot so a deploy fills every pipe on its own.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { db as DbInstance } from "../db/index.js";
import { workflows, workflowSiblingLines, workflowSiblingLinePipes } from "../db/schema.js";
import type { DAG } from "./dag-validator.js";
import { fetchPipe, listLegAssignments, type LegAssignment } from "./catalogue-client.js";
import { chatServicePlatformComplete, type PlatformCaller } from "./chat-service-client.js";
import {
  SIBLING_LINE_RESPONSE_SCHEMA,
  SIBLING_LINE_RULES_VERSION,
  linesFromAnswer,
  siblingGroups,
  siblingLineMessage,
  siblingLineSystemPrompt,
  starName,
  type PipeMember,
  type SiblingGroup,
} from "./sibling-line.js";

type Database = typeof DbInstance;

const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
const TRIES = 3;

export interface SiblingLineDeps {
  listAssignments: (featureSlug: string) => Promise<LegAssignment[]>;
  /** The names the page already shows for this pipe (pipe, channel): a line never repeats them. */
  pipeWords: (featureSlug: string, legKey: string) => Promise<string[]>;
  complete: (systemPrompt: string, message: string) => Promise<unknown>;
}

/**
 * No run stands behind a short line by design (it rides write traffic and a boot sweep) and it produces no outcome:
 * it is display text on the staff Research page, so its spend is a declared support function (PLATFORM-CALLER-RUN-1024).
 */
export const SIBLING_LINE_CALLER: PlatformCaller = {
  support: {
    kind: "product_feature",
    reason: "workflow-service writes the short line that sets sibling workflows of one pipe apart on the Research page; display only, no outcome",
  },
};

export const defaultSiblingLineDeps: SiblingLineDeps = {
  listAssignments: (featureSlug) => listLegAssignments(featureSlug),
  pipeWords: async (featureSlug, legKey) => {
    const pipe = await fetchPipe(`${featureSlug}|${legKey}`);
    return pageWords(pipe.name, pipe.channelName);
  },
  complete: async (systemPrompt, message) => {
    const res = await chatServicePlatformComplete({
      provider: "anthropic",
      model: "sonnet",
      systemPrompt,
      message,
      responseFormat: "json",
      responseSchema: SIBLING_LINE_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 4000,
    }, SIBLING_LINE_CALLER);
    return res.json;
  },
};

/** The pipe's name, the channel's name and every pair of adjacent words in it ("Cold Email" out of "Sales Cold Email Outreach"). */
export function pageWords(pipeName: string, channelName: string): string[] {
  const words = channelName.split(/\s+/).filter(Boolean);
  const pairs = words.slice(1).map((w, i) => `${words[i]} ${w}`);
  return [...new Set([pipeName, channelName, ...pairs])];
}

interface Head {
  id: string;
  workflowDynastySlug: string;
  workflowDynastyName: string;
  signature: string;
  version: number;
}

/** The hash a pipe's lines were written for. */
export function siblingsKey(heads: Head[], running: Set<string>): string {
  const parts = heads
    .map((h) => `${h.workflowDynastySlug}:${h.id}:${h.signature}:${running.has(h.workflowDynastySlug) ? "running" : "stopped"}`)
    .sort();
  return createHash("sha256").update([`rules ${SIBLING_LINE_RULES_VERSION}`, ...parts].join("\n")).digest("hex");
}

/** One model call (three tries) for these groups, or the reason it could not be written. */
async function askLines(
  groups: SiblingGroup[],
  banned: string[],
  complete: SiblingLineDeps["complete"],
  opts: { taken?: string[]; assign?: (m: PipeMember) => boolean } = {},
): Promise<{ lines: Map<string, string> } | { problem: string }> {
  const system = siblingLineSystemPrompt();
  const message = siblingLineMessage(groups, opts.taken);
  let problem = "";
  for (let attempt = 0; attempt < TRIES; attempt++) {
    let answer: unknown;
    try {
      answer = await complete(system, message + (attempt ? `\n\nYour previous answer was refused: ${problem}. Fix that.` : ""));
    } catch (err) {
      problem = `chat-service call failed: ${err instanceof Error ? err.message : String(err)}`;
      continue;
    }
    const r = linesFromAnswer(groups, answer, banned, opts);
    if ("lines" in r) return r;
    problem = r.problem;
  }
  return { problem };
}

/**
 * Lines for one pipe's members. The RUNNING workflows are set apart from each other only (what the owner reads
 * first: why several run at once), then every other one is set apart from the whole pipe, never reusing a running
 * one's line. With fewer than two running, one call sets everyone apart from everyone.
 */
export async function writePipeLines(
  members: PipeMember[],
  banned: string[],
  complete: SiblingLineDeps["complete"],
): Promise<{ lines: Map<string, string> } | { problem: string }> {
  const lines = new Map<string, string>();
  const running = members.filter((m) => m.running);
  if (running.length >= 2) {
    const r = await askLines(siblingGroups(running), banned, complete);
    if ("problem" in r) return { problem: `running workflows: ${r.problem}` };
    for (const [k, v] of r.lines) lines.set(k, v);
  }
  if (lines.size === members.length) return { lines };
  const assign = (m: PipeMember) => !lines.has(m.workflowDynastySlug);
  const groups = siblingGroups(members).filter((g) => g.members.some(assign));
  const r = await askLines(groups, banned, complete, { taken: [...lines.values()], assign });
  if ("problem" in r) return { problem: r.problem };
  for (const [k, v] of r.lines) lines.set(k, v);
  return { lines };
}

export interface SweepReport {
  pipes: number;
  written: number;
  unchanged: number;
  single: number;
  failed: string[];
}

/** One sweep over every channel this service holds workflows for. */
export async function sweepSiblingLines(db: Database, deps: SiblingLineDeps = defaultSiblingLineDeps): Promise<SweepReport> {
  const report: SweepReport = { pipes: 0, written: 0, unchanged: 0, single: 0, failed: [] };
  const features = (await db.selectDistinct({ featureSlug: workflows.featureSlug }).from(workflows)).map((r) => r.featureSlug);
  for (const featureSlug of features) {
    try {
      await sweepFeature(db, deps, featureSlug, report);
    } catch (err) {
      report.failed.push(`${featureSlug}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return report;
}

async function sweepFeature(db: Database, deps: SiblingLineDeps, featureSlug: string, report: SweepReport): Promise<void> {
  const assignments = await deps.listAssignments(featureSlug);
  const rows = await db
    .select({
      id: workflows.id,
      workflowDynastySlug: workflows.workflowDynastySlug,
      workflowDynastyName: workflows.workflowDynastyName,
      signature: workflows.signature,
      version: workflows.version,
      status: workflows.status,
      workflowDynastyStatus: workflows.workflowDynastyStatus,
    })
    .from(workflows)
    .where(eq(workflows.featureSlug, featureSlug));
  const heads = new Map<string, Head>();
  for (const r of rows) {
    const h = heads.get(r.workflowDynastySlug);
    if (!h || r.version > h.version) heads.set(r.workflowDynastySlug, r);
  }
  const running = new Set(
    rows.filter((r) => r.status === "active" && r.workflowDynastyStatus === "active").map((r) => r.workflowDynastySlug),
  );
  const legs = new Map<string, Head[]>();
  for (const a of assignments) {
    const h = heads.get(a.workflowDynastySlug);
    if (!h) continue;
    const list = legs.get(a.legKey) ?? [];
    if (!list.some((x) => x.workflowDynastySlug === h.workflowDynastySlug)) list.push(h);
    legs.set(a.legKey, list);
  }

  const stored = await db.select().from(workflowSiblingLinePipes).where(eq(workflowSiblingLinePipes.featureSlug, featureSlug));
  // A pipe no longer holding any of our workflows: its lines go.
  for (const s of stored) {
    if (legs.has(s.legKey)) continue;
    await clearPipe(db, featureSlug, s.legKey);
    await db
      .delete(workflowSiblingLinePipes)
      .where(and(eq(workflowSiblingLinePipes.featureSlug, featureSlug), eq(workflowSiblingLinePipes.legKey, s.legKey)));
  }

  for (const [legKey, members] of legs) {
    report.pipes++;
    const key = siblingsKey(members, running);
    const prior = stored.find((s) => s.legKey === legKey);
    if (prior && prior.siblingsKey === key) {
      if (prior.state !== "failed" || Date.now() - prior.computedAt.getTime() < FAILED_RETRY_MS) {
        report.unchanged++;
        continue;
      }
    }
    if (members.length < 2) {
      await clearPipe(db, featureSlug, legKey);
      await recordPipe(db, featureSlug, legKey, key, "single", null);
      report.single++;
      continue;
    }
    const dags = await db
      .select({ id: workflows.id, dag: workflows.dag })
      .from(workflows)
      .where(inArray(workflows.id, members.map((m) => m.id)));
    const dagOf = new Map(dags.map((d) => [d.id, d.dag as DAG | null]));
    const pipeMembers: PipeMember[] = members.map((m) => ({
      workflowDynastySlug: m.workflowDynastySlug,
      running: running.has(m.workflowDynastySlug),
      displayName: starName(m.workflowDynastyName, featureSlug),
      dag: dagOf.get(m.id) ?? null,
    }));
    const banned = await deps.pipeWords(featureSlug, legKey);
    const result = await writePipeLines(pipeMembers, banned, deps.complete);
    if ("problem" in result) {
      await clearPipe(db, featureSlug, legKey);
      await recordPipe(db, featureSlug, legKey, key, "failed", result.problem);
      report.failed.push(`${featureSlug}|${legKey}: ${result.problem}`);
      continue;
    }
    await db.transaction(async (tx) => {
      await clearPipe(tx as unknown as Database, featureSlug, legKey);
      await tx.insert(workflowSiblingLines).values(
        [...result.lines].map(([workflowDynastySlug, line]) => ({ featureSlug, legKey, workflowDynastySlug, line })),
      );
      await recordPipe(tx as unknown as Database, featureSlug, legKey, key, "written", null);
    });
    report.written++;
  }
}

async function clearPipe(db: Database, featureSlug: string, legKey: string): Promise<void> {
  await db
    .delete(workflowSiblingLines)
    .where(and(eq(workflowSiblingLines.featureSlug, featureSlug), eq(workflowSiblingLines.legKey, legKey)));
}

async function recordPipe(db: Database, featureSlug: string, legKey: string, siblingsKey: string, state: string, problem: string | null) {
  const computedAt = new Date();
  await db
    .insert(workflowSiblingLinePipes)
    .values({ featureSlug, legKey, siblingsKey, state, problem, computedAt })
    .onConflictDoUpdate({
      target: [workflowSiblingLinePipes.featureSlug, workflowSiblingLinePipes.legKey],
      set: { siblingsKey, state, problem, computedAt },
    });
}

/** The lines of a set of dynasties, keyed by dynasty slug (a dynasty on several pipes has one per pipe). */
export async function readSiblingLines(
  db: Database,
  workflowDynastySlugs: string[],
): Promise<Map<string, Array<{ legKey: string; line: string }>>> {
  const out = new Map<string, Array<{ legKey: string; line: string }>>();
  if (workflowDynastySlugs.length === 0) return out;
  const rows = await db
    .select()
    .from(workflowSiblingLines)
    .where(inArray(workflowSiblingLines.workflowDynastySlug, [...new Set(workflowDynastySlugs)]));
  for (const r of rows ?? []) {
    const list = out.get(r.workflowDynastySlug) ?? [];
    list.push({ legKey: r.legKey, line: r.line });
    out.set(r.workflowDynastySlug, list);
  }
  for (const list of out.values()) list.sort((a, b) => a.legKey.localeCompare(b.legKey));
  return out;
}

/** The one line to show when the page does not name the pipe: the dynasty's line when all its pipes agree. */
export function singleSiblingLine(lines: Array<{ line: string }> | undefined): string | null {
  if (!lines?.length) return null;
  return lines.every((l) => l.line === lines[0].line) ? lines[0].line : null;
}

export class SiblingLineRefresher {
  private lastRunAt = 0;
  private inFlight = false;

  constructor(
    private db: Database,
    private minIntervalMs: number,
    private deps: SiblingLineDeps = defaultSiblingLineDeps,
  ) {}

  maybeRun(): void {
    if (this.inFlight) return;
    if (Date.now() - this.lastRunAt < this.minIntervalMs) return;
    this.lastRunAt = Date.now();
    this.inFlight = true;
    sweepSiblingLines(this.db, this.deps)
      .then((r) => {
        if (r.written || r.single || r.failed.length) {
          console.log(
            `[workflow-service] sibling lines: pipes ${r.pipes}, written ${r.written}, unchanged ${r.unchanged}, single ${r.single}, failed ${r.failed.length}`,
          );
        }
        for (const f of r.failed) console.error(`[workflow-service] sibling lines FAILED ${f}`);
      })
      .catch((err) => console.error("[workflow-service] sibling lines sweep failed:", err instanceof Error ? err.message : err))
      .finally(() => {
        this.inFlight = false;
      });
  }
}

let shared: SiblingLineRefresher | null = null;

export function setSiblingLineRefresher(r: SiblingLineRefresher | null): void {
  shared = r;
}

/** Called with every workflow write and run dispatch (see `noteWorkflowWrite`). */
export function noteSiblingLinesMaybeStale(): void {
  shared?.maybeRun();
}
