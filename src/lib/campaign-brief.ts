/**
 * THE CAMPAIGN'S BRIEF reaches every LLM step of a campaign run (ONE-BRIEF-1105, owner 2026-11-05: « le text de
 * stratégie de la campaign soit donné en input à tous les LLM (pas que email, de façon structurelle pour tous les
 * clients) »).
 *
 * campaign-service reports the brief on `/start-run` (`brief`, the text the client edits on the dashboard campaign
 * page; it absorbed the former `instruction`). It is handed VERBATIM, at CONVERSION time (`dag-to-openflow.ts`), to
 * every LLM door a node downstream of start-run calls, whatever the workflow, channel or brand:
 *  - content-generation writer doors (`/generate`, `/generate/materials`, `/generate-whatsapp`, `/generate-thread`):
 *    `body.brief` (content-generation puts it in the writer's system prompt itself);
 *  - chat-service `/complete` and `/internal/copilot/lead-turns`: appended to `body.systemPrompt` under
 *    `BRIEF_HEADER`, unless the call's own prompt or message already carries the brief word for word (a writer that
 *    frames it itself is never handed it twice);
 *  - chat-service `/orgs/judgments`: appended to `body.state` (text: under the header; object: `campaignBrief`;
 *    list: `{items, campaignBrief}`).
 * No brief (null, absent, blank) = every request byte-identical. A stored DAG mapping the retired
 * `$ref:<start-run>.output.instruction` is read as `.output.brief` (`aliasRetiredInstructionRef`), so no stored DAG
 * reads the instruction. Never a per-workflow, per-channel or per-node list: a new LLM door is one more entry here.
 */
import type { DAGNode } from "./dag-validator.js";

/** The field campaign-service's `/start-run` serves the brief under. */
export const BRIEF_FIELD = "brief";

/** The header the brief sits under when appended to a system prompt or a judged text. */
export const BRIEF_HEADER =
  "THE CAMPAIGN'S BRIEF (written by our client for this whole campaign, verbatim; it was written without knowing this person, so where it assumes something the rest of this prompt, the thread or who they are to us contradicts, those win):";

const svc = (node: DAGNode) => String(node.config?.service ?? "").replace(/_/g, "-");
const path = (node: DAGNode) => String(node.config?.path ?? "");

/** A content-generation writer door: it takes the brief as `body.brief`. */
export function callsContentWriterDoor(node: DAGNode): boolean {
  return (
    node.type === "http.call" &&
    svc(node) === "content-generation" &&
    /\/(generate(\/materials)?|generate-whatsapp|generate-thread)$/.test(path(node))
  );
}

/** How a chat-service LLM door takes the brief, or null when the node calls none. */
export function chatLlmDoorKind(node: DAGNode): "systemPrompt" | "state" | null {
  if (node.type !== "http.call" || svc(node) !== "chat") return null;
  const p = path(node);
  if (p === "/complete" || p === "/internal/copilot/lead-turns") return "systemPrompt";
  if (p === "/orgs/judgments") return "state";
  return null;
}

/**
 * The JS expression of the request body with the brief appended (see the module doc). `bodyExpr` is the node's
 * already-collapsed body expression; `briefRef` reads the run's brief. Evaluated by Windmill at dispatch.
 */
export function bodyWithBriefExpr(bodyExpr: string, briefRef: string, kind: "systemPrompt" | "state"): string {
  const header = JSON.stringify(BRIEF_HEADER);
  const fn =
    kind === "systemPrompt"
      ? `(b, r) => { const brief = typeof r === "string" ? r.trim() : ""; ` +
        `if (!brief || !b || typeof b !== "object") return b; ` +
        `const sys = typeof b.systemPrompt === "string" ? b.systemPrompt : ""; ` +
        `const msg = typeof b.message === "string" ? b.message : ""; ` +
        `if (sys.includes(brief) || msg.includes(brief)) return b; ` +
        `return { ...b, systemPrompt: (sys ? sys + "\\n\\n" : "") + ${header} + "\\n" + brief }; }`
      : `(b, r) => { const brief = typeof r === "string" ? r.trim() : ""; ` +
        `if (!brief || !b || typeof b !== "object") return b; const s = b.state; ` +
        `if (typeof s === "string") return s.includes(brief) ? b : { ...b, state: s + "\\n\\n" + ${header} + "\\n" + brief }; ` +
        `if (Array.isArray(s)) return { ...b, state: { items: s, campaignBrief: brief } }; ` +
        `if (s && typeof s === "object") return { ...b, state: { ...s, campaignBrief: brief } }; ` +
        `return b; }`;
  return `(${fn})(${bodyExpr}, ${briefRef})`;
}

/** `$ref:<startRun>.output.instruction` (the retired field) read as the brief; any other mapping unchanged. */
export function aliasRetiredInstructionRef(
  inputMapping: Record<string, string> | undefined,
  startRunNodeId: string | null,
): Record<string, string> | undefined {
  if (!inputMapping || !startRunNodeId) return inputMapping;
  const retired = `$ref:${startRunNodeId}.output.instruction`;
  let changed = false;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inputMapping)) {
    if (v === retired) {
      out[k] = `$ref:${startRunNodeId}.output.${BRIEF_FIELD}`;
      changed = true;
    } else out[k] = v;
  }
  return changed ? out : inputMapping;
}
