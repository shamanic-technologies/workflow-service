/**
 * SOPHIE-COPILOT-WA-1018 (owner 2026-10-18: « ça doit être le skill client-comms qui doit être partagé partout où
 * Sophie parle (MCP, API, Copilot, WA, Email, etc) »): every writer reads chat-service's `client-comms` skill LIVE,
 * right before its model call, and writes in that voice. A staff edit of the skill reaches the very next message.
 */
import { LLM_PICK_NODE_ID, LLM_PLAN_NODE_ID } from "../../src/lib/leg-best-writer.js";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIENT_COMMS_READ_NODE_ID,
  CLIENT_COMMS_UNREADABLE,
  CLIENT_COMMS_VOICE_CODE,
  CLIENT_COMMS_VOICE_NODE_ID,
  readsClientComms,
  withClientCommsVoice,
} from "../../src/lib/client-comms.js";
import { validateDAG, type DAG } from "../../src/lib/dag-validator.js";
import { dagToOpenFlow } from "../../src/lib/dag-to-openflow.js";
import { buildFollowUpProactiveDag, buildFollowUpReactiveDag } from "../../src/lib/follow-up-dag.js";
import { buildColdWhatsappOutreachDag } from "../../src/lib/cold-whatsapp-outreach-dag.js";
import { buildFormMeetingBookingDag } from "../../src/lib/form-meeting-booking-dag.js";
import { buildAiMeetingBookingDag, needsClientCommsVoice } from "../../src/lib/ai-meeting-booking-dag.js";
import { buildOfferDocumentReplyDag } from "../../src/lib/offer-document-reply-dag.js";
import { followUpArgs, replyArgs } from "../fixtures/sender-persona-args.js";

type Fn = (...args: unknown[]) => Promise<Record<string, any>>;
const loadMain = (code: string): Fn =>
  new Function(code.replace(/^export async function main/m, "async function main") + "\nreturn main;")() as Fn;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const a = fixture("trigger-right-moment-occurrence.json").args as Record<string, any>;
const WHO = { state: "not_known", lines: ["Not known to the brand."], threadLines: [], strategy: "WHO STRATEGY" };

const CELL = { provider: "anthropic", model: "opus", omitTemperature: true } as const;

/** Every writer: its DAG, the model call a person's message is drafted by, the node that builds its prompt, and args. */
const WRITERS: Array<{ name: string; dag: DAG; draft: string; compose: string; args: () => unknown[] }> = [
  { name: "follow-up (served)", dag: buildFollowUpProactiveDag(), draft: "draft", compose: "compose", args: () => followUpArgs() },
  { name: "follow-up (claimed)", dag: buildFollowUpReactiveDag({ readFigures: false }), draft: "draft", compose: "compose", args: () => followUpArgs() },
  { name: "follow-up (claimed, figures)", dag: buildFollowUpReactiveDag({ readFigures: true }), draft: "draft", compose: "compose", args: () => followUpArgs() },
  {
    name: "cold WhatsApp outreach",
    dag: buildColdWhatsappOutreachDag(),
    draft: "draft-message",
    compose: "compose-message",
    args: () => [a.person, a.instruction, a.offer, a.brand, a.rep, a.facts, a.history, a.currentDate, a.occurrence, a.triggerType, a.who, { skip: false, owed: false }],
  },
  {
    name: "form meeting booking",
    dag: buildFormMeetingBookingDag(),
    draft: "draft-answer",
    compose: "compose-answer",
    args: () => [
      { rowId: "row-1", email: "jo@example.com", fullName: "Jo Smith", firstName: "Jo", form: null, eventId: null },
      { name: "Private dinners", bookingUrl: "https://cal.example.com/doc" },
      { brand: { name: "Doc Dinners" } },
      { salesRepFirstName: "Joe" },
      { exact: [], neverGive: [] },
      "2026-10-16",
      WHO,
    ],
  },
  { name: "AI meeting booking", dag: buildAiMeetingBookingDag(CELL), draft: "draft-reply", compose: "compose-prompt", args: () => replyArgs() },
  { name: "offer-document reply", dag: buildOfferDocumentReplyDag(CELL), draft: "draft-reply", compose: "compose-prompt", args: () => replyArgs() },
];

const SKILL_V1 = { slug: "client-comms", version: 7, content: "# How we talk\n- Answer first.\n- Short and warm." };
const SKILL_V2 = { ...SKILL_V1, version: 8, content: SKILL_V1.content + "\n- Always open with their first name." };

const node = (dag: DAG, id: string) => dag.nodes.find((n) => n.id === id)!;

/** What the writer's model call receives as its system prompt, run through the DAG's own stored scripts. */
async function promptTheModelGets(w: (typeof WRITERS)[number], skill: unknown): Promise<string> {
  const composed = await loadMain(node(w.dag, w.compose).config!.code as string)(...w.args());
  const voice = node(w.dag, CLIENT_COMMS_VOICE_NODE_ID);
  const out = await loadMain(voice.config!.code as string)(composed.systemPrompt, skill, undefined);
  return out.systemPrompt as string;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T12:00:00.000Z"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(WRITERS)("$name reads client-comms live before it writes", (w) => {
  it("reads the skill from chat-service right before its model call, failing loud", () => {
    const read = node(w.dag, CLIENT_COMMS_READ_NODE_ID);
    expect(read.config).toEqual({ service: "chat", method: "GET", path: "/internal/skills/{slug}", params: { slug: "client-comms" } });
    expect(read.config).not.toHaveProperty("tolerateFailure");
    // BEST-TPL-LLM-1022: the voice runs into the leg's LLM pick, which runs into the writer.
    expect(w.dag.edges.filter((e) => e.to === LLM_PICK_NODE_ID)).toEqual([{ from: CLIENT_COMMS_VOICE_NODE_ID, to: LLM_PICK_NODE_ID }]);
    expect(w.dag.edges.filter((e) => e.to === w.draft)).toEqual([{ from: LLM_PLAN_NODE_ID, to: w.draft }]);
    expect(w.dag.edges).toContainEqual({ from: CLIENT_COMMS_READ_NODE_ID, to: CLIENT_COMMS_VOICE_NODE_ID });
    expect(node(w.dag, w.draft).inputMapping?.["body.systemPrompt"]).toBe(`$ref:${CLIENT_COMMS_VOICE_NODE_ID}.output.systemPrompt`);
    expect(node(w.dag, CLIENT_COMMS_VOICE_NODE_ID).inputMapping?.skill).toBe(`$ref:${CLIENT_COMMS_READ_NODE_ID}.output`);
    // A model call skipped this run skips the read too: never a read for a message nobody writes.
    const skip = node(w.dag, w.draft).inputMapping?.skip;
    expect(read.inputMapping?.skip).toBe(skip);
    expect(node(w.dag, CLIENT_COMMS_VOICE_NODE_ID).inputMapping?.skip).toBe(skip);
    expect(readsClientComms(w.dag)).toBe(true);
    expect(validateDAG(w.dag).valid).toBe(true);
    expect(() => dagToOpenFlow(w.dag, "f/x")).not.toThrow();
  });

  it("a one-line change of the skill reaches its next message prompt, and the writer's own prompt is unchanged", async () => {
    const composed = await loadMain(node(w.dag, w.compose).config!.code as string)(...w.args());
    const before = await promptTheModelGets(w, SKILL_V1);
    const after = await promptTheModelGets(w, SKILL_V2);
    expect(before).not.toContain("Always open with their first name.");
    expect(after).toContain("- Always open with their first name.");
    expect(after.replace("\n- Always open with their first name.", "")).toBe(before);
    // WHAT it writes is its own prompt, byte for byte; the skill only comes after it.
    expect(before.startsWith(composed.systemPrompt + "\n\nOUR VOICE.")).toBe(true);
    expect(before).toContain("<<< OUR VOICE\n" + SKILL_V1.content + "\nOUR VOICE >>>");
    expect(before).not.toMatch(/[–—]/);
  });

  it("never writes in a default voice: an unreadable skill throws before the model call", async () => {
    const composed = await loadMain(node(w.dag, w.compose).config!.code as string)(...w.args());
    const voice = loadMain(node(w.dag, CLIENT_COMMS_VOICE_NODE_ID).config!.code as string);
    for (const bad of [undefined, null, {}, { content: "" }, { content: "   " }, { error: "Skill not found" }]) {
      await expect(voice(composed.systemPrompt, bad, undefined)).rejects.toThrow(CLIENT_COMMS_UNREADABLE);
    }
  });
});

describe("the voice step", () => {
  const voice = loadMain(CLIENT_COMMS_VOICE_CODE);

  it("passes the prompt through untouched when the writer's model call does not run", async () => {
    expect(await voice("", { notCalled: true, skipped: true }, true)).toEqual({ systemPrompt: "", voiced: false, skillVersion: null });
  });

  it("refuses a missing writer prompt", async () => {
    await expect(voice(undefined, SKILL_V1, false)).rejects.toThrow(/system prompt is missing/);
  });

  it("states the skill version it wrote with", async () => {
    expect(await voice("P", SKILL_V1, false)).toMatchObject({ voiced: true, skillVersion: 7 });
  });

  it("refuses a DAG it cannot voice, and a DAG already voiced", () => {
    const dag = buildFormMeetingBookingDag();
    expect(() => withClientCommsVoice(dag, "draft-answer")).toThrow(/already reads/);
    expect(() => withClientCommsVoice({ nodes: [{ id: "x", type: "script", config: { code: "" } }], edges: [] }, "x")).toThrow(/not a chat-service \/complete call/);
  });

  it("seed predicate: a stored responder drafting without our voice is stale", () => {
    const voiced = buildAiMeetingBookingDag(CELL);
    expect(needsClientCommsVoice(voiced)).toBe(false);
    const stale = { nodes: voiced.nodes.filter((n) => n.id !== CLIENT_COMMS_VOICE_NODE_ID) };
    expect(needsClientCommsVoice(stale)).toBe(true);
  });

  it("never copies the skill's text into code", () => {
    const dir = new URL("../../src/lib/", import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const src = readFileSync(new URL(f, dir), "utf8");
      expect(src, f).not.toContain("How we talk to a person");
      expect(src, f).not.toContain("revenue made easy. A message wins");
    }
  });
});
