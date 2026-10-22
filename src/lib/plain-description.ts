/**
 * What a workflow's description says (BEST-TPL-LLM-1022 follow-up, staff Research page shows it verbatim on every
 * pipe): what the sequence DOES, in plain English. A workflow fixes no template and no LLM any more (each run writes
 * with its leg's best), so a description naming one is false; and features-service judges the workflow's tactics on
 * this text, so every rule about who it reaches, skips or serves must stay in it.
 */
export const DESCRIPTION_RULES = [
  "Say what the sequence does on its pipe: its shape (steps in order), how many messages and follow-ups, the delays between them, and its tactic.",
  "Keep every rule about WHO it reaches, skips or serves (for example: fresh contacts only, leads only, business contacts only, people reachable by phone, answers only email replies), stated plainly.",
  "Never describe the email's wording, angle, tone, or whether it names the client: the template picked each run decides that.",
  "Skip the platform steps every workflow has (budget checks, opening and closing the run, reading the brand).",
  "Plain English, one or two short sentences (about 40 words; up to 90 only when a rule about who it reaches needs them), no jargon, no node or service names.",
  "Never name a template, a model, an LLM, a provider, a test, an experiment, a version or a date: every run writes with the template and the LLM ranked best on its leg.",
  "No em dash and no en dash.",
].join(" ");

/** The description with every em/en dash rewritten (a hyphen between digits, else a comma) and its spacing tidied. */
export function plainDescription(text: string): string;
export function plainDescription(text: string | undefined): string | undefined;
export function plainDescription(text: string | null): string | null;
export function plainDescription(text: string | null | undefined): string | null | undefined;
export function plainDescription(text: string | null | undefined): string | null | undefined {
  if (typeof text !== "string") return text;
  return text
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    .replace(/\s*[–—]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

const FORBIDDEN = /\b(opus|sonnet|haiku|gemini|gpt|glm|fable|deepseek|claude|llm|model|template|prompt|test|experiment|v\d+|20\d\d-\d\d)/i;

/** Why a description breaks the rules, or null when it reads right. */
export function descriptionProblem(text: string): string | null {
  if (/[–—]/.test(text)) return "contains an em or en dash";
  const m = text.match(FORBIDDEN);
  if (m) return `names "${m[0]}"`;
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length > 2) return `has ${sentences.length} sentences`;
  if (text.length < 20) return "too short";
  if (text.split(/\s+/).length > 90) return "longer than 90 words";
  return null;
}
