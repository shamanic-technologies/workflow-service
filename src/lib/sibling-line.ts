/**
 * WF-SHORT-LINE-1023: one short line per workflow saying what sets it apart from its siblings on the SAME pipe (owner
 * 2026-10-23, staff Research page: « Je ne comprends pas pourquoi il y a autant de workflows actifs… rends la desc plus
 * courte… On est sur Dotterel, donc on sait déjà le leg »). Display only: the description stays what it is, since
 * features-service's Jev judges every tactic on it.
 *
 * Pure part (no I/O): a DAG flattened into facts, the facts every sibling shares removed, siblings with equal fact sets
 * grouped (twins), the model's lines checked. `sibling-line-refresher.ts` reads the pipes and stores the lines.
 */
import type { DAG } from "./dag-validator.js";
import { FORBIDDEN, plainDescription } from "./plain-description.js";
import { LLM_PICK_NODE_ID, LLM_PLAN_NODE_ID, WRITER_PICK_NODE_ID, WRITER_PLAN_NODE_ID } from "./leg-best-writer.js";
import { TEMPLATE_HEAD_NODE_ID } from "./template-dynasty.js";

/** Bump when the rules or the fact reading change: every pipe's lines are written again on the next sweep. */
export const SIBLING_LINE_RULES_VERSION = "1";

/** A line is at most this many words; a twin group's own part leaves room for "same steps as <Name>". */
export const MAX_LINE_WORDS = 10;
export const MAX_TWIN_GROUP_WORDS = 5;

/**
 * Facts the line never states: which template or LLM a call pins, and the steps that pick them each run (a workflow
 * writes with its leg's best, and the line never names either), and send tags (bookkeeping, nothing the person
 * reached sees).
 */
const UNSTATED_FACT = /\.(body|params)\.(type|model|provider|temperature|tags)(\.|\s=)/;
const WRITER_PICK_FACT = new RegExp(
  `(^|[\\s:>$])(${[WRITER_PICK_NODE_ID, WRITER_PLAN_NODE_ID, LLM_PICK_NODE_ID, LLM_PLAN_NODE_ID, TEMPLATE_HEAD_NODE_ID].join("|")})\\b`,
);

/** A DAG as a set of facts: nodes, stated body/params values, mappings, edges (script code by length only). */
export function dagFacts(dag: DAG | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const n of dag?.nodes ?? []) {
    const c = (n.config ?? {}) as Record<string, unknown>;
    out.add(`step ${n.id}: ${n.type} ${c.method ?? ""} ${c.service ?? ""} ${c.path ?? ""}`.replace(/\s+/g, " ").trim());
    const walk = (o: unknown, p: string): void => {
      if (o && typeof o === "object" && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, `${p}.${k}`);
      else out.add(`${n.id}${p} = ${JSON.stringify(o)}`);
    };
    if (c.body) walk(c.body, ".body");
    if (c.params) walk(c.params, ".params");
    if (typeof c.code === "string") out.add(`${n.id} script of ${c.code.length} chars`);
    for (const [k, v] of Object.entries(n.inputMapping ?? {})) out.add(`${n.id} ${k} <- ${v}`);
  }
  for (const e of dag?.edges ?? []) out.add(`edge ${e.from} -> ${e.to}${e.condition ? ` if ${e.condition}` : ""}`);
  return out;
}

/** The facts a line may speak of (template / LLM pins and send tags removed). */
export function lineFacts(dag: DAG | null | undefined): Set<string> {
  return new Set([...dagFacts(dag)].filter((f) => !UNSTATED_FACT.test(f) && !WRITER_PICK_FACT.test(f)));
}

export interface PipeMember {
  workflowDynastySlug: string;
  /** A version of it can run now: running workflows are set apart from each other first. */
  running?: boolean;
  /** What the staff read on the page (the dynasty name's star part, e.g. "Keel"). */
  displayName: string;
  dag: DAG | null;
}

export interface SiblingGroup {
  key: string;
  members: PipeMember[];
  /** Facts this group holds that not every group holds. */
  own: string[];
}

/** Siblings grouped by equal fact sets (a group of 2+ = twins), each with the facts not every group shares. */
export function siblingGroups(members: PipeMember[]): SiblingGroup[] {
  const byFacts = new Map<string, { facts: Set<string>; members: PipeMember[] }>();
  for (const m of members) {
    const facts = lineFacts(m.dag);
    const sig = [...facts].sort().join("\n");
    const g = byFacts.get(sig) ?? { facts, members: [] };
    g.members.push(m);
    byFacts.set(sig, g);
  }
  const groups = [...byFacts.values()].map((g) => ({ ...g, members: g.members.sort((a, b) => a.displayName.localeCompare(b.displayName)) }));
  const common = new Set([...(groups[0]?.facts ?? [])].filter((f) => groups.every((g) => g.facts.has(f))));
  return groups
    .sort((a, b) => a.members[0].displayName.localeCompare(b.members[0].displayName))
    .map((g, i) => ({ key: `G${i + 1}`, members: g.members, own: [...g.facts].filter((f) => !common.has(f)).sort() }));
}

/** The star part of a dynasty name ("Sales Cold Email Outreach Keel" -> "Keel"). */
export function starName(workflowDynastyName: string, featureSlug: string): string {
  const prefix = featureSlug.split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
  const rest = workflowDynastyName.startsWith(prefix) ? workflowDynastyName.slice(prefix.length).trim() : workflowDynastyName;
  return rest || workflowDynastyName;
}

/** What the model is told. `pipeWords` are the names the page already shows (pipe, channel, steps): never repeated. */
export function siblingLineSystemPrompt(): string {
  return [
    "Several workflows run on the SAME pipe and are listed side by side for the staff who must understand at a glance why each exists.",
    "For each GROUP below, write ONE short line that states ONLY what sets that group apart from the other groups, read from its own facts (the facts every group shares are already removed).",
    `A line is a fragment of at most ${MAX_LINE_WORDS} words, like "Brand name + website link" or "Lightest lead brief, no timezone timing". A group marked TWINS gets at most ${MAX_TWIN_GROUP_WORDS} words (its members' names are appended for you).`,
    "Speak of what changes for the person reached or the writer: extra steps, the brand or lead facts the writer gets, who it serves or skips, timing rules. Ignore differences that change nothing for the person reached (internal addresses, field order, script length alone).",
    "Plain words a sales owner understands at a glance: never an id, a field name, a mode or an internal step name.",
    "A group with no own facts is the plainest one: say so in its own words (for example \"Base version, no extras\").",
    "Never repeat what every group does. Never name the pipe, the leg or the channel (the page already says them).",
    "Never describe the writing style, angle or tone, nor who or what picks it: every workflow writes with the best one of the moment.",
    "Never name a template, a model, an LLM, a provider, a test, an experiment, a version or a date. No em dash, no en dash. No two lines may be the same.",
    'Answer JSON {"lines": [{"group": "G1", "line": "..."}]} with one entry per group.',
  ].join(" ");
}

export const SIBLING_LINE_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lines"],
  properties: {
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["group", "line"],
        properties: { group: { type: "string" }, line: { type: "string" } },
      },
    },
  },
} as const;

/** The model's message: every group with its own facts (capped so one long DAG cannot flood the call). */
export function siblingLineMessage(groups: SiblingGroup[], taken: string[] = []): string {
  const head = taken.length
    ? `Lines already shown for the RUNNING workflows (never reuse one, and say what sets each group below apart from them too):\n${taken.map((t) => `- ${t}`).join("\n")}\n\n`
    : "";
  return head + groups
    .map((g) => {
      const head = `## ${g.key}${g.members.length > 1 ? " (TWINS)" : ""}: ${g.members.map((m) => m.displayName).join(", ")}`;
      return `${head}\nOwn facts:\n${g.own.slice(0, 80).join("\n") || "(none)"}`;
    })
    .join("\n\n");
}

const wordCount = (s: string): number => s.split(/\s+/).filter(Boolean).length;

/** Why a line breaks the rules, or null. `banned` = the names the page already shows (pipe, channel, steps). */
export function siblingLineProblem(line: string, maxWords: number, banned: string[]): string | null {
  if (!line.trim()) return "is empty";
  if (/[–—]/.test(line)) return "contains an em or en dash";
  const forbidden = line.match(FORBIDDEN);
  if (forbidden) return `names "${forbidden[0]}"`;
  const word = line.match(/\b(pipe|pipes|leg|legs|channel|channels)\b/i);
  if (word) return `names "${word[0]}"`;
  const lower = line.toLowerCase();
  const name = banned.find((b) => b.trim().length > 2 && lower.includes(b.trim().toLowerCase()));
  if (name) return `names "${name}", which the page already shows`;
  if (wordCount(line) > maxWords) return `has ${wordCount(line)} words (at most ${maxWords})`;
  return null;
}

/** "a, b" -> trailing punctuation stripped, dashes rewritten, spacing tidied. */
function tidy(line: string): string {
  return plainDescription(line).replace(/[.;:,\s]+$/, "");
}

/**
 * The model's answer -> one line per dynasty, or the problem to send back. A twin group's members get its line plus
 * "same steps as <next member>" (cyclic), so twins read apart and say plainly they run the same steps.
 */
export function linesFromAnswer(
  groups: SiblingGroup[],
  answer: unknown,
  banned: string[],
  opts: { taken?: string[]; assign?: (m: PipeMember) => boolean } = {},
): { lines: Map<string, string> } | { problem: string } {
  const taken = new Set((opts.taken ?? []).map((t) => t.toLowerCase()));
  const assign = opts.assign ?? (() => true);
  const raw = (answer as { lines?: Array<{ group?: unknown; line?: unknown }> } | null)?.lines;
  if (!Array.isArray(raw)) return { problem: "no lines array" };
  const byGroup = new Map(raw.map((r) => [String(r.group ?? ""), tidy(String(r.line ?? ""))]));
  const problems: string[] = [];
  for (const g of groups) {
    const line = byGroup.get(g.key);
    if (line === undefined) {
      problems.push(`${g.key} is missing`);
      continue;
    }
    const p = siblingLineProblem(line, g.members.length > 1 ? MAX_TWIN_GROUP_WORDS : MAX_LINE_WORDS, banned);
    if (p) problems.push(`${g.key} "${line}" ${p}`);
  }
  const folded = groups.map((g) => (byGroup.get(g.key) ?? "").toLowerCase());
  const dup = groups.filter((_, i) => folded.indexOf(folded[i]) !== i).map((g) => g.key);
  if (dup.length) problems.push(`${dup.join(", ")} repeat another group's line: state each group's OWN difference`);
  const reused = groups.filter((g, i) => taken.has(folded[i])).map((g) => g.key);
  if (reused.length) problems.push(`${reused.join(", ")} reuse a running workflow's line`);
  if (problems.length) return { problem: problems.join("; ") };

  const lines = new Map<string, string>();
  for (const g of groups) {
    const line = byGroup.get(g.key)!;
    if (g.members.length === 1) {
      if (assign(g.members[0])) lines.set(g.members[0].workflowDynastySlug, line);
      continue;
    }
    g.members.forEach((m, i) => {
      if (!assign(m)) return;
      const next = g.members[(i + 1) % g.members.length];
      lines.set(m.workflowDynastySlug, `${line}, same steps as ${next.displayName}`);
    });
  }
  return { lines };
}
