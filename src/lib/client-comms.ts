/**
 * OUR ONE VOICE, read live before every message a writer drafts (SOPHIE-COPILOT-WA-1018, owner 2026-10-18: « ça doit
 * être le skill client-comms qui doit être partagé partout où Sophie parle (MCP, API, Copilot, WA, Email, etc) »).
 *
 * chat-service owns the skill `client-comms` (`GET /internal/skills/{slug}`, service api-key, markdown in `content`),
 * the single source of HOW anything we run talks to a client or prospect. Staff edit it live; the web and WhatsApp
 * Copilot and content-generation's cold emails read it on every message. Every writer here reads it the same way, on
 * every run, right before its model call: `withClientCommsVoice(dag, draftNodeId)` splices two nodes into the edge
 * running into the writer's chat-service `/complete` call:
 *
 *   read-client-comms  (http.call chat GET /internal/skills/client-comms: a failed read throws, nothing is sent)
 *   client-comms-voice (script: the writer's system prompt + the skill's content, verbatim, under OUR VOICE)
 *
 * and repoints the call's `body.systemPrompt` at the voiced prompt. The writer's own prompt is untouched byte for
 * byte: it keeps WHAT to write (its job, its facts, its decision, its output format); the skill says HOW. Nothing of
 * the skill is copied here: the text is fetched on each run, so a staff edit reaches the very next message.
 *
 * Never a default voice: an unreadable skill (failed read, empty content) fails the run before any model spend.
 * A writer whose model call is skipped this run (its `skip` mapping) skips the read too.
 */
import type { DAG, DAGNode } from "./dag-validator.js";

export const CLIENT_COMMS_SKILL_SLUG = "client-comms";
export const CLIENT_COMMS_READ_NODE_ID = "read-client-comms";
export const CLIENT_COMMS_VOICE_NODE_ID = "client-comms-voice";

/** The refusal named in the run log when the skill cannot be read: nothing is written in a default voice. */
export const CLIENT_COMMS_UNREADABLE = "client_comms_unreadable";

/**
 * Appends the skill to the writer's system prompt. Kept free of em and en dashes: the model copies its prompt's style.
 * `skip` true = the writer's model call does not run this run: the prompt passes through, nothing was read.
 */
export const CLIENT_COMMS_VOICE_CODE = `
export async function main(systemPrompt, skill, skip) {
  if (skip === true) return { systemPrompt: typeof systemPrompt === "string" ? systemPrompt : "", voiced: false, skillVersion: null };
  if (typeof systemPrompt !== "string" || !systemPrompt.trim()) {
    throw new Error("client-comms-voice: the writer's system prompt is missing; nothing is written");
  }
  const content = skill && typeof skill === "object" && typeof skill.content === "string" ? skill.content.trim() : "";
  if (!content) {
    throw new Error("${CLIENT_COMMS_UNREADABLE}: the ${CLIENT_COMMS_SKILL_SLUG} skill (our voice) was not read: " + String(JSON.stringify(skill) ?? skill).slice(0, 200) + "; nothing is written in a default voice");
  }
  const version = typeof skill.version === "number" ? skill.version : null;
  console.log("[client-comms] writing in our voice, ${CLIENT_COMMS_SKILL_SLUG} v" + String(version));
  return {
    systemPrompt: [
      systemPrompt,
      "",
      "OUR VOICE. The text between the two markers below is how everything we send talks to a person, kept by our team and read fresh for this message. Follow it for HOW you write: tone, wording, warmth, how long and plain each sentence is. Where it differs from a line above about tone or style, it wins, except YOUR OWN INSTRUCTIONS when they are stated above. WHAT you write stays as set above: your job, the facts you may use, your decision and your output format. It may name tools or routes: they are not yours, you only write this message.",
      "<<< OUR VOICE",
      content,
      "OUR VOICE >>>",
    ].join("\\n"),
    voiced: true,
    skillVersion: version,
  };
}
`.trim();

/** True when the DAG already reads our voice (a seed's staleness predicate). */
export function readsClientComms(dag: { nodes?: Array<{ id?: string }> } | null | undefined): boolean {
  return (dag?.nodes ?? []).some((n) => n?.id === CLIENT_COMMS_VOICE_NODE_ID);
}

/**
 * Splices the voice into the edge running into `draftNodeId` (a chat-service `/complete` writer call whose
 * `body.systemPrompt` is mapped). Throws when the DAG does not have that shape: a writer is never left unvoiced.
 */
export function withClientCommsVoice(dag: DAG, draftNodeId: string): DAG {
  if (readsClientComms(dag)) throw new Error(`withClientCommsVoice: the DAG already reads ${CLIENT_COMMS_SKILL_SLUG}`);
  const draft = dag.nodes.find((n) => n.id === draftNodeId);
  if (!draft || draft.type !== "http.call" || draft.config?.service !== "chat" || draft.config?.path !== "/complete") {
    throw new Error(`withClientCommsVoice: "${draftNodeId}" is not a chat-service /complete call`);
  }
  const promptRef = draft.inputMapping?.["body.systemPrompt"];
  if (typeof promptRef !== "string" || !promptRef.startsWith("$ref:")) {
    throw new Error(`withClientCommsVoice: "${draftNodeId}" maps no body.systemPrompt`);
  }
  const incoming = dag.edges.filter((e) => e.to === draftNodeId);
  if (incoming.length !== 1) {
    throw new Error(`withClientCommsVoice: "${draftNodeId}" has ${incoming.length} incoming edges, expected exactly one`);
  }
  const skipRef = draft.inputMapping?.skip;
  const skip: Record<string, string> = typeof skipRef === "string" ? { skip: skipRef } : {};

  const read: DAGNode = {
    id: CLIENT_COMMS_READ_NODE_ID,
    type: "http.call",
    config: { service: "chat", method: "GET", path: "/internal/skills/{slug}", params: { slug: CLIENT_COMMS_SKILL_SLUG } },
    retries: 2,
    inputMapping: { ...skip },
  };
  const voice: DAGNode = {
    id: CLIENT_COMMS_VOICE_NODE_ID,
    type: "script",
    config: { code: CLIENT_COMMS_VOICE_CODE },
    retries: 0,
    inputMapping: { systemPrompt: promptRef, skill: `$ref:${CLIENT_COMMS_READ_NODE_ID}.output`, ...skip },
  };

  const nodes = dag.nodes.flatMap((n) =>
    n.id === draftNodeId
      ? [read, voice, { ...n, inputMapping: { ...n.inputMapping, "body.systemPrompt": `$ref:${CLIENT_COMMS_VOICE_NODE_ID}.output.systemPrompt` } }]
      : [n],
  );
  const edges = dag.edges.flatMap((e) =>
    e === incoming[0]
      ? [
          { ...e, to: CLIENT_COMMS_READ_NODE_ID },
          { from: CLIENT_COMMS_READ_NODE_ID, to: CLIENT_COMMS_VOICE_NODE_ID },
          { from: CLIENT_COMMS_VOICE_NODE_ID, to: draftNodeId },
        ]
      : [e],
  );
  return { ...dag, nodes, edges };
}
