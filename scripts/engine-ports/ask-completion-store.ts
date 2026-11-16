/**
 * ONE-WRITER-N-MODELS-1116-OTHERS: prints the catalogue writes that move the scripts of `ask-completion-scripts.ts`
 * onto the LLM completion Engine (one JSON line each, dry by construction; pipe them into
 * `scripts/post-catalogue-ops.mjs`). Reads ONE JSON object on stdin, read from production right before (the stored
 * code is the source of truth):
 *   {scripts: [{outcome, dynasty, code, tactics, description}], cases: {"<outcome>/<dynasty>": [<stored case>...]},
 *    copies: {"<outcome>/<dynasty>": {<its active tactics>}}}
 * `--only <outcome>/<dynasty>,...` narrows to those survivors. Per survivor: a PORT (recorded cases) = `upgradeWithCases`
 * (cases restated, any case its active code does not replay excluded by id), else `create` (= an upgrade of the stored
 * dynasty); then each per-model copy `merge`d: counted at the survivor, and at its model's completion script asked by it.
 */
import { readFileSync } from "node:fs";
import { replayAll, type ReplayCase } from "../../src/lib/scripts/replay.js";
import { askCompletionSource, askCompletionTactics, COMPLETION_OUTCOME, restateCase } from "./ask-completion.js";
import { ASKING_SCRIPTS, completionDynastyOf, MERGE_REASON } from "./ask-completion-scripts.js";

interface Stored {
  outcome: string;
  dynasty: string;
  code: string;
  tactics: Record<string, unknown>;
  description: string;
}

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt >= 0 ? new Set(String(process.argv[onlyAt + 1] ?? "").split(",")) : null;
const input = JSON.parse(readFileSync(0, "utf8")) as { scripts: Stored[]; cases?: Record<string, ReplayCase[]>; copies?: Record<string, Record<string, unknown>> };
const out = (o: unknown) => console.log(JSON.stringify(o));
const day = new Date().toISOString().slice(0, 10);

for (const def of ASKING_SCRIPTS) {
  const slug = `${def.outcome}/${def.dynasty}`;
  if (only && !only.has(slug)) continue;
  const stored = input.scripts.find((s) => s.outcome === def.outcome && s.dynasty === def.dynasty);
  if (!stored) throw new Error(`stdin holds no active ${slug}`);
  const code = askCompletionSource(stored.code, def.edits, slug);
  const tactics = { ...askCompletionTactics(stored.tactics), ...(def.addTactics ?? {}) };
  const description = def.description ?? stored.description;
  const cases = input.cases?.[slug] ?? [];
  if (cases.length > 0) {
    const asRecorded = await replayAll(stored.code, cases.map((c) => ({ ...c, tactics: { ...stored.tactics, ...(c.tactics ?? {}) } })));
    const unreplayable = new Set(asRecorded.failures.map((f) => f.id));
    const excluded: Record<string, string> = {};
    const restated: Record<string, unknown>[] = [];
    for (const c of cases) {
      if (unreplayable.has(c.id)) {
        excluded[c.id] = "the active version does not replay the record";
        continue;
      }
      const r = restateCase(c as unknown as Record<string, unknown>, (stored.tactics.llm as Record<string, unknown>) ?? null, def.doors ?? []);
      if ("excluded" in r) excluded[c.id] = r.excluded;
      else restated.push(r.case);
    }
    if (restated.length === 0) throw new Error(`${slug}: no case left to prove it on`);
    const proof = await replayAll(code, restated.map((c) => ({ ...(c as unknown as ReplayCase), tactics: { ...tactics, ...((c.tactics as Record<string, unknown>) ?? {}) } })));
    if (proof.matches !== proof.cases) throw new Error(`${slug}: the upgrade replays ${proof.matches}/${proof.cases} restated cases: ${JSON.stringify(proof.failures.slice(0, 2))}`);
    console.error(`${slug}: ${restated.length}/${cases.length} cases restated and replayed 100 %, excluded ${JSON.stringify(excluded)}`);
    out({
      op: "upgradeWithCases",
      outcome: def.outcome,
      dynasty: def.dynasty,
      code,
      tactics,
      ...(def.description ? { description } : {}),
      source: `the dynasty's stored cases ${day}, restated under ONE-WRITER-N-MODELS-1116 (the completion asked of llm_completion)`,
      cases: restated,
      excluded,
    });
  } else {
    out({ op: "create", body: { outcome: def.outcome, dynasty: def.dynasty, code, description, tactics } });
  }
  for (const copy of def.merged ?? []) {
    const copyTactics = input.copies?.[`${def.outcome}/${copy}`];
    if (!copyTactics) throw new Error(`stdin holds no active copy ${def.outcome}/${copy}`);
    const model = (copyTactics.llm as { model?: unknown } | undefined)?.model;
    if (typeof model !== "string" || !model) throw new Error(`${def.outcome}/${copy} states no model`);
    out({
      op: "merge",
      absorbed: `${def.outcome}/${copy}`,
      places: [
        { survivor: slug, askedBy: null },
        { survivor: `${COMPLETION_OUTCOME}/${completionDynastyOf(model)}`, askedBy: slug },
      ],
      reason: MERGE_REASON,
    });
  }
}
