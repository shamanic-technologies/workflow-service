/**
 * CAMPAIGN-SCRIPTS-1113-NAMES: every script dynasty carries a short human NAME a client reads as one line on their
 * campaign page ("Brand team assistant", "Follow-up when due"), beside how often the Rating draws it. A name belongs to
 * the DYNASTY: every version carries the same one (an upgrade or a re-home copies it), it is unique within its Engine
 * (outcome, every status), and a fork is a new idea, so it gets a new name.
 *
 * Who names: the caller when it states `name` on create/fork, else a model reading the description and tactics beside the
 * names its Engine already holds (one chat-service platform call, a declared support function: display only, no outcome).
 * A name is checked by `scriptNameProblem` (no slug, no version, no em/en dash, no "agency", short); a model whose answer
 * fails is told why and asked again, three tries, then the create fails loud (nothing written). Dynasties stored before
 * names existed are named by `nameUnnamedScripts` (a sweep after boot, one call per outcome chunk).
 */
import { and, asc, eq, isNotNull, isNull, ne } from "drizzle-orm";
import { scripts } from "../../db/schema.js";
import { chatServicePlatformComplete, type PlatformCaller } from "../chat-service-client.js";
import { ScriptCatalogueError, type AnyPgDb } from "./script-catalogue.js";

export const SCRIPT_NAME_MAX_CHARS = 40;
const TRIES = 3;
/** Dynasties named per model call in the sweep (an outcome with 60+ forks is named in several calls). */
const SWEEP_CHUNK = 20;

/** Why a name cannot be served to a client, or null when it can. */
export function scriptNameProblem(name: string): string | null {
  const n = name.trim();
  if (n.length < 2) return "the name is empty";
  if (n.length > SCRIPT_NAME_MAX_CHARS) return `the name is longer than ${SCRIPT_NAME_MAX_CHARS} characters`;
  if (/[\n\r\t]/.test(n)) return "the name holds a line break";
  if (/[—–]/.test(n)) return "the name holds an em or en dash";
  if (/[_/\\`{}[\]<>|]/.test(n)) return "the name holds a code character (underscore, slash, bracket)";
  if (/\bdy\b|\bv\d+\b|\bversion\b/i.test(n)) return "the name holds a slug or a version";
  if (/agenc/i.test(n)) return "the name holds the word agency";
  if (!/[a-z]/i.test(n[0]!)) return "the name must open on a letter";
  return null;
}

/** Two names a client could not tell apart. */
export function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return norm(a) === norm(b);
}

export interface DynastyToName {
  dynasty: string;
  description: string;
  tactics: Record<string, unknown>;
}

/** Names for these dynasties of one outcome, each different from `taken` and from one another (keyed by dynasty). */
export type NameDynasties = (outcome: string, toName: DynastyToName[], taken: string[]) => Promise<Map<string, string>>;

/** The names an Engine already serves (every dynasty but `exceptDynasty`, any status). */
export async function takenNames(db: AnyPgDb, outcome: string, exceptDynasty?: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ name: scripts.name })
    .from(scripts)
    .where(and(eq(scripts.outcome, outcome), isNotNull(scripts.name), ...(exceptDynasty ? [ne(scripts.dynasty, exceptDynasty)] : [])));
  return rows.map((r) => r.name!).filter(Boolean);
}

/** A stated name, checked (400 `invalid_name`) and free in its Engine (409 `name_taken`). */
export function checkStatedName(name: string, taken: string[]): string {
  const n = name.trim().replace(/\s+/g, " ");
  const problem = scriptNameProblem(n);
  if (problem) throw new ScriptCatalogueError(400, "invalid_name", `script name refused: ${problem}`);
  if (taken.some((t) => sameName(t, n))) throw new ScriptCatalogueError(409, "name_taken", `another script of this Engine is already named "${n}"`);
  return n;
}

/** The name of a NEW dynasty: the one stated, else the namer's. */
export async function nameNewDynasty(db: AnyPgDb, outcome: string, dynasty: DynastyToName, stated: string | undefined, namer: NameDynasties): Promise<string> {
  const taken = await takenNames(db, outcome, dynasty.dynasty);
  if (stated !== undefined) return checkStatedName(stated, taken);
  const names = await namer(outcome, [dynasty], taken);
  const name = names.get(dynasty.dynasty);
  if (!name) throw new Error(`no name written for ${outcome}/${dynasty.dynasty}`);
  return name;
}

/** Rename a whole dynasty (every version), checked like a stated name. */
export async function renameDynasty(db: AnyPgDb, outcome: string, dynasty: string, name: string): Promise<string> {
  const [any] = await db.select({ id: scripts.id }).from(scripts).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty))).limit(1);
  if (!any) throw new ScriptCatalogueError(404, "not_found", `no script ${outcome}/${dynasty}`);
  const n = checkStatedName(name, await takenNames(db, outcome, dynasty));
  await db.update(scripts).set({ name: n }).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, dynasty)));
  return n;
}

// ─── The model namer ─────────────────────────────────────────────────────────────────────────────────────────────────

export const SCRIPT_NAME_CALLER: PlatformCaller = {
  support: {
    kind: "product_feature",
    reason: "workflow-service names each script dynasty once, the line a client reads on their campaign page; display only, no outcome",
  },
};

export const SCRIPT_NAME_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["names"],
  properties: {
    names: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["dynasty", "name"],
        properties: { dynasty: { type: "string" }, name: { type: "string" } },
      },
    },
  },
} as const;

export function scriptNameSystemPrompt(): string {
  return [
    "You name scripts for a client's campaign page.",
    "A script is one way our platform makes one result for the client. Several scripts compete for the same result (an Engine), and the client reads ONE line per script beside how often it is picked.",
    "Each name tells the client which script it is: what it does, for whom, or what sets it apart from the other scripts of the same Engine (who it serves, how it acts, when it acts, which AI model writes).",
    "Rules for every name:",
    `- Plain English, 2 to 5 words, at most ${SCRIPT_NAME_MAX_CHARS} characters, first word capitalized, no full stop.`,
    "- Never a code, slug, file or template id, version number, underscore or slash. A hyphen inside a word (follow-up) is fine; never any other dash.",
    "- Never the word agency.",
    "- When scripts differ only by the AI model that writes, name the model plainly (Claude Sonnet, GPT Pro, Gemini Flash), never its id.",
    "- Every name differs from every other name of the Engine, the taken ones included.",
    'Answer JSON: {"names": [{"dynasty": "<the id you were given>", "name": "<the name>"}]}, exactly one entry per script you were asked to name.',
  ].join("\n");
}

/** The facts a name can be read off: long prompt text clipped (it says HOW, never which script it is). */
function compactTactics(tactics: Record<string, unknown>): string {
  const text = JSON.stringify(tactics, (_k, v) => (typeof v === "string" && v.length > 200 ? `${v.slice(0, 200)}...` : v));
  return text.length > 1500 ? `${text.slice(0, 1500)}...` : text;
}

export function scriptNameMessage(outcome: string, toName: DynastyToName[], taken: string[]): string {
  const lines = [
    `Engine (the result these scripts make): ${outcome.replace(/_/g, " ")}`,
    `Names already taken in this Engine: ${taken.length ? taken.map((t) => `"${t}"`).join(", ") : "none"}`,
    "",
    "Scripts to name:",
  ];
  for (const d of toName) {
    lines.push(`- id: ${d.dynasty}`, `  what it does: ${d.description.slice(0, 1500)}`, `  its settings: ${compactTactics(d.tactics)}`);
  }
  return lines.join("\n");
}

/** Read and check a model's answer; the problem a retry is told, or the names. */
export function readNameAnswer(answer: unknown, toName: DynastyToName[], taken: string[]): { names: Map<string, string> } | { problem: string } {
  const list = (answer as { names?: unknown })?.names;
  if (!Array.isArray(list)) return { problem: "the answer has no names list" };
  const names = new Map<string, string>();
  const wanted = new Set(toName.map((d) => d.dynasty));
  for (const item of list) {
    const dynasty = typeof item?.dynasty === "string" ? item.dynasty : "";
    const name = typeof item?.name === "string" ? item.name.trim().replace(/\s+/g, " ") : "";
    if (!wanted.has(dynasty)) continue;
    const problem = scriptNameProblem(name);
    if (problem) return { problem: `"${name}" (${dynasty}): ${problem}` };
    if (taken.some((t) => sameName(t, name))) return { problem: `"${name}" (${dynasty}) is already taken in this Engine` };
    if ([...names.values()].some((t) => sameName(t, name))) return { problem: `"${name}" is given to two scripts` };
    names.set(dynasty, name);
  }
  const missing = toName.filter((d) => !names.has(d.dynasty)).map((d) => d.dynasty);
  if (missing.length) return { problem: `no name for ${missing.join(", ")}` };
  return { names };
}

/** A namer on a model call (`complete(systemPrompt, message)` answers the parsed JSON). */
export function modelNamer(complete: (systemPrompt: string, message: string) => Promise<unknown>): NameDynasties {
  return async (outcome, toName, taken) => {
    const system = scriptNameSystemPrompt();
    const message = scriptNameMessage(outcome, toName, taken);
    let problem = "";
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const answer = await complete(system, message + (attempt ? `\n\nYour previous answer was refused: ${problem}. Fix that.` : ""));
      const read = readNameAnswer(answer, toName, taken);
      if ("names" in read) return read.names;
      problem = read.problem;
    }
    throw new Error(`no usable script name for ${outcome} after ${TRIES} tries: ${problem}`);
  };
}

export function productionNamer(): NameDynasties {
  return modelNamer(async (systemPrompt, message) => {
    const res = await chatServicePlatformComplete(
      {
        provider: "anthropic",
        model: "sonnet",
        systemPrompt,
        message,
        responseFormat: "json",
        responseSchema: SCRIPT_NAME_RESPONSE_SCHEMA as unknown as Record<string, unknown>,
        maxTokens: 4000,
      },
      SCRIPT_NAME_CALLER,
    );
    return res.json;
  });
}

// ─── The sweep: dynasties stored before names existed ───────────────────────────────────────────────────────────────

/**
 * Name every dynasty that has none, per outcome (chunks of `SWEEP_CHUNK`, each chunk told the names given before it),
 * every version of a dynasty written at once. One outcome failing is logged and the others go on; the next sweep retries.
 */
export async function nameUnnamedScripts(db: AnyPgDb, namer: NameDynasties): Promise<{ named: number; failed: string[] }> {
  const unnamed = await db
    .select({ outcome: scripts.outcome, dynasty: scripts.dynasty, version: scripts.version, description: scripts.description, tactics: scripts.tactics })
    .from(scripts)
    .where(isNull(scripts.name))
    .orderBy(asc(scripts.outcome), asc(scripts.dynasty));
  // One entry per dynasty: its highest version describes it.
  const byOutcome = new Map<string, Map<string, DynastyToName & { version: number }>>();
  for (const r of unnamed) {
    const dyns = byOutcome.get(r.outcome) ?? new Map();
    const prev = dyns.get(r.dynasty);
    if (!prev || r.version > prev.version) dyns.set(r.dynasty, { dynasty: r.dynasty, description: r.description, tactics: (r.tactics as Record<string, unknown>) ?? {}, version: r.version });
    byOutcome.set(r.outcome, dyns);
  }
  let named = 0;
  const failed: string[] = [];
  for (const [outcome, dyns] of byOutcome) {
    const all = [...dyns.values()];
    for (let i = 0; i < all.length; i += SWEEP_CHUNK) {
      const chunk = all.slice(i, i + SWEEP_CHUNK);
      try {
        const names = await namer(outcome, chunk, await takenNames(db, outcome));
        for (const d of chunk) {
          await db.update(scripts).set({ name: names.get(d.dynasty)! }).where(and(eq(scripts.outcome, outcome), eq(scripts.dynasty, d.dynasty), isNull(scripts.name)));
          named++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[workflow-service] script names: naming ${outcome} (${chunk.map((d) => d.dynasty).join(", ")}) FAILED: ${message}`);
        failed.push(outcome);
        break;
      }
    }
  }
  if (named || failed.length) console.log(`[workflow-service] script names: ${named} dynasties named${failed.length ? `, failed on ${failed.join(", ")}` : ""}`);
  return { named, failed };
}
