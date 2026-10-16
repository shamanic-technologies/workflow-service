/**
 * WHO SPEAKS on WhatsApp is the persona of the account that SENDS (SOPHIE-WA-1016, owner 2026-10-16).
 *
 * A brand owner may link a dedicated WhatsApp number with its own persona (a name, a role, its own instructions:
 * an AI assistant, a team member). crm-service chooses the sending account and states its persona on
 * `POST /orgs/whatsapp/reach` (`{reachable: true, to, phoneSource, fromAccount, persona}`, `persona` =
 * `{name, role, instructions} | null`). When a persona is stated, every WhatsApp writer speaks AS that persona: its
 * name and role, its instructions as its style, never the owner imitating his own voice, and it never needs owner
 * voice samples. When none is stated (null, absent, no name), every writer's prompt is the one it had before.
 *
 * The workflow never picks the account (crm-service does) and the rep alert recipient never changes: a hand-over
 * still reaches the brand's sales rep.
 */

/** `senderPersona(reach)`: the persona of the account that will send, or null. A persona with no name is none. */
export const SENDER_PERSONA_FN = `
function senderPersona(reach) {
  const p = reach && typeof reach === "object" && reach.persona && typeof reach.persona === "object" ? reach.persona : null;
  const s = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
  if (!p || !s(p.name)) return null;
  return { name: s(p.name), role: s(p.role), instructions: s(p.instructions) };
}

function personaLines(persona, brandName) {
  return [
    "WHO YOU ARE: you are " + persona.name + (persona.role ? ", " + persona.role : "") + " at " + brandName + ". You write from " + brandName + "'s WhatsApp number as yourself, " + persona.name + ": never as anyone else, never imitating how someone else at " + brandName + " writes.",
    "Present yourself exactly as your role says. If your role says you are an AI or an assistant, never say or imply you are a human, and if they ask, say plainly what you are.",
    "Messages in the thread typed by someone else at " + brandName + " are part of the history, never a model of how you write. Where a line says to write the way the owner or the founder would, write as yourself, in your own voice, keeping the relationship and its language.",
    ...(persona.instructions ? ["YOUR OWN INSTRUCTIONS (how you write and present yourself; they win over any other line about style or tone):", persona.instructions] : []),
  ];
}
`.trim();
