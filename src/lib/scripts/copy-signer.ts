/**
 * COPY-SIGNER-1121 (OUTREACH-3WAYS-1121): a cold email sender can copy (Cc) the person the email is signed as.
 *
 * Tactic `copiesSigner: true` on a sender dynasty means: when the campaign's BRIEF asks that every email copy the person
 * it is signed as (Jev `noul`, judged once per brief, kept in the Engine's storage table `copy_signer_briefs`), the email
 * is signed as the brand's stated sales rep (brand-service `GET /orgs/brands/{brandId}/sales-rep`: first name, role,
 * address, the brand's own data, never inferred) and that rep's address is the email's Cc, named by the script on
 * `email.send` (email-gateway broadcast `cc`, forwarded verbatim; empty = nobody copied).
 *
 * A brief that does not ask (or no brief) = the very same run as before: no Cc, the signature the script states
 * (`signedBy` / its `signature` tactic), one Jev call per distinct brief and nothing else. A brief that asks on a brand
 * that states no rep address = `unmade no_signer_address` (nothing written, nothing sent: copying nobody would break the
 * brief's own rule). Which campaigns keep a copying script is the strategy « Copies the signer on every email »
 * (features-service, requires the script tactic of the same meaning), judged on the brief like every strategy.
 *
 * The edit is made on each sender's STORED code at its own lines (`addCopySigner`), nothing else rewritten. Two codes:
 * - the cold email sender (`dy_cold_email*`): the rep signs (before `signedBy`, so no signer completion is asked), the
 *   writer reads that signature word for word (SENDER-NAME-BODY-1111), the send names the Cc;
 * - the intro first email (`dy_intro_*`): the writer speaks as the rep (persona + signature), the send names the Cc.
 * Never a default copy in a sender, never a branch on a brand, campaign or slug.
 */

export const COPY_SIGNER_TACTIC = "copiesSigner";
export const COPY_SIGNER_STORAGE = "copy_signer_briefs";
export const COPY_SIGNER_QUESTION =
  "The state is a campaign brief a client wrote. Does it ask that the emails copy (Cc) the person they are signed as, or a named person of the client's own team (for example: always copy Kevin, put our founder in copy)?";

const HELPER =
  "\n" +
  "/**\n" +
  " * COPY-SIGNER-1121: tactic `copiesSigner`. When the campaign's brief asks that every email copy the person it is\n" +
  " * signed as (Jev, judged once per brief, kept), the email is signed as the brand's stated sales rep and that rep's\n" +
  " * address is the Cc this script names on the send. Otherwise null: the run is the same as without the tactic.\n" +
  " */\n" +
  `const COPY_SIGNER_QUESTION = ${JSON.stringify(COPY_SIGNER_QUESTION)};\n` +
  "function copiedSigner(ctx: any, tactics: any, brief: unknown, brandId: unknown, brandName: string, now: string): any {\n" +
  `  if (tactics?.${COPY_SIGNER_TACTIC} !== true) return null;\n` +
  '  const text = typeof brief === "string" ? brief.trim() : "";\n' +
  "  if (!text) return null;\n" +
  "  let h = 0x811c9dc5;\n" +
  "  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }\n" +
  '  const key = "brief:" + h.toString(16) + ":" + text.length;\n' +
  `  let v: any = ctx.storage.get(${JSON.stringify(COPY_SIGNER_STORAGE)}, key);\n` +
  "  if (v === null || v === undefined) {\n" +
  '    const j = ctx.vendor.call("jev.noul", { state: { brief: text }, questions: { asks: { instructions: COPY_SIGNER_QUESTION } } });\n' +
  '    if (!j.ok) throw new Error("jev.noul (copy signer): " + String(j.data.error));\n' +
  "    const pr = j.data?.probabilities?.asks;\n" +
  '    if (typeof pr !== "number") throw new Error("copy signer: Jev answered no probability on the brief");\n' +
  "    v = { asks: pr >= 0.5, probability: pr, at: now };\n" +
  `    ctx.storage.set(${JSON.stringify(COPY_SIGNER_STORAGE)}, key, v);\n` +
  "  }\n" +
  "  if (v.asks !== true) return null;\n" +
  '  const rep = ctx.vendor.call("brand.sales_rep", { params: { brandId } });\n' +
  '  if (!rep.ok) throw new Error("brand.sales_rep (copy signer): " + String(rep.data.error));\n' +
  '  const email = typeof rep.data?.salesRepEmail === "string" ? rep.data.salesRepEmail.trim().toLowerCase() : "";\n' +
  '  if (!email) return { refused: "no_signer_address: the brief asks to copy the person the email is signed as, and the brand states no sales rep address" };\n' +
  '  const firstName = typeof rep.data?.salesRepFirstName === "string" ? rep.data.salesRepFirstName.trim() : "";\n' +
  '  const role = typeof rep.data?.salesRepRole === "string" ? rep.data.salesRepRole.trim() : "";\n' +
  '  const lines = [firstName, role && brandName ? role + ", " + brandName : role || brandName].filter((l) => l !== "");\n' +
  '  return { email, firstName, role, signature: lines.join("\\n") };\n' +
  "}\n";

/** The stored codes' own lines (each found exactly once, else nothing is generated). */
export const COLD_ANCHORS = {
  signedBy: '  let signature: unknown = undefined;\n  if (tactics.signedBy === "sender_with_client_brand") {\n',
  sendSignature: "      ...(signature !== undefined ? { signature } : {}),\n",
};
export const INTRO_ANCHORS = {
  tactics: "  const t: any = ctx.tactics ?? {};\n",
  brandName: "  const brandName = s(brand.name);\n",
  sendSignature: "      ...(s(t.signature) ? { signature: { text: s(t.signature) } } : {}),\n",
};

const COLD_SIGNED_BY =
  "  // COPY-SIGNER-1121: a brief asking to copy the person the email is signed as = the brand's sales rep signs and is copied.\n" +
  "  const copied = copiedSigner(ctx, tactics, req.brief, brandId, brandName, req.now);\n" +
  '  if (copied && "refused" in copied) return { unmade: copied.refused };\n' +
  "  let signature: unknown = undefined;\n" +
  "  if (copied) {\n" +
  "    signature = { text: copied.signature };\n" +
  '  } else if (tactics.signedBy === "sender_with_client_brand") {\n';
const COLD_CC = "      ...(copied ? { cc: copied.email } : {}),\n";

const INTRO_TACTICS = "  const t: any = { ...(ctx.tactics ?? {}) };\n";
const INTRO_BRAND =
  "  // COPY-SIGNER-1121: a brief asking to copy the person the email is signed as = the brand's sales rep writes, signs and is copied.\n" +
  "  const copied = copiedSigner(ctx, t, R.brief, brandId, brandName, now);\n" +
  '  if (copied && "refused" in copied) return { unmade: copied.refused };\n' +
  "  if (copied) {\n" +
  '    t.persona = { name: copied.firstName || brandName, says: (copied.role ? copied.role + " of " : "of the team of ") + brandName + ", who introduces people to each other" };\n' +
  "    t.signature = copied.signature;\n" +
  "  }\n";
const INTRO_CC = "      ...(copied ? { cc: copied.email } : {}),\n";

export type SenderCode = "cold" | "intro";

function once(code: string, anchor: string, name: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) throw new Error(`copy-signer: the stored code holds the ${name} line ${at < 0 ? "nowhere" : "more than once"}: nothing generated`);
  return at;
}

/** Which of the two sender codes a stored code is (by its own lines), or null. */
export function senderCodeOf(code: string): SenderCode | null {
  if (code.includes(COLD_ANCHORS.signedBy) && code.includes(COLD_ANCHORS.sendSignature)) return "cold";
  if (code.includes(INTRO_ANCHORS.tactics) && code.includes(INTRO_ANCHORS.sendSignature)) return "intro";
  return null;
}

/** The sender's stored code able to copy its signer. Throws when an anchor moved or the edit is already in. */
export function addCopySigner(code: string): string {
  if (code.includes("function copiedSigner(")) throw new Error("copy-signer: the stored code already copies its signer");
  const kind = senderCodeOf(code);
  if (kind === "cold") {
    const a = once(code, COLD_ANCHORS.signedBy, "signedBy");
    const b = once(code, COLD_ANCHORS.sendSignature, "send signature") + COLD_ANCHORS.sendSignature.length;
    if (!(a < b)) throw new Error("copy-signer: the stored lines are not in the expected order: nothing generated");
    return code.slice(0, a) + COLD_SIGNED_BY + code.slice(a + COLD_ANCHORS.signedBy.length, b) + COLD_CC + code.slice(b) + HELPER;
  }
  if (kind === "intro") {
    const a = once(code, INTRO_ANCHORS.tactics, "tactics");
    const b = once(code, INTRO_ANCHORS.brandName, "brand name") + INTRO_ANCHORS.brandName.length;
    const c = once(code, INTRO_ANCHORS.sendSignature, "send signature") + INTRO_ANCHORS.sendSignature.length;
    if (!(a < b && b < c)) throw new Error("copy-signer: the stored lines are not in the expected order: nothing generated");
    return code.slice(0, a) + INTRO_TACTICS + code.slice(a + INTRO_ANCHORS.tactics.length, b) + INTRO_BRAND + code.slice(b, c) + INTRO_CC + code.slice(c) + HELPER;
  }
  throw new Error("copy-signer: the stored code is neither the cold email sender nor the intro first email: nothing generated");
}

/** The tactics of the upgraded version: the stored ones plus `copiesSigner: true` (nothing else moves). */
export function copySignerTactics(tactics: Record<string, unknown>): Record<string, unknown> {
  return { ...tactics, [COPY_SIGNER_TACTIC]: true };
}

/**
 * The dynasties whose version carries the tactic: the cold senders a cold campaign can pick that hold no recorded
 * production cases (the two ports `dy_cold_email` / `dy_cold_email_site` must replay 100 % of theirs, and a brief judge
 * call is not in them: a brief asking for a copy keeps the copying scripts only), and the three intro first emails.
 */
export const COPY_SIGNER_SENDERS = [
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_client_person" },
  { outcome: "email_sent", dynasty: "dy_cold_email_signed_sender_client_brand" },
  { outcome: "email_sent", dynasty: "dy_intro_open" },
  { outcome: "email_sent", dynasty: "dy_intro_lead_to_lead" },
  { outcome: "email_sent", dynasty: "dy_intro_client_to_lead" },
] as const;
