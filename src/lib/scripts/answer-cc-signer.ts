/**
 * ANSWER-CC-SIGNER-1121 (OUTREACH-3WAYS-1121): the lead answerer knows WHO the brand's sales rep is (first name, role,
 * address), so a brief asking "always copy Kevin" names the right address.
 *
 * The answer writer decides who is copied (COPY-BY-WRITER-1116) and reads the campaign's brief, but it was never handed
 * the rep's address: on our investors campaign it copied Kevin's SENDING mailbox from the thread
 * (lourd@growthagency.diy) instead of kevin@distribute.you. The sender (`message_sent/dy_answer_lead`) now reads
 * brand-service's stated sales rep (`brand.sales_rep`, the door the cold senders' copy already reads) and hands it in the
 * writer's material; the writer (`message_written/dy_answer_lead`) states it as one fact line. No rep address stated =
 * nothing handed and the writer's prompt byte for byte. WHO to copy stays the writer's decision: never a cc added by
 * code, never a rule per brief.
 *
 * Applied to the STORED code of both halves by anchored edits (UPGRADES); a moved anchor = nothing generated.
 */

const SENDER_ANCHOR = "  // 5. THE WRITER decides and writes (message_written, ONE-WRITER-N-MODELS-1116-ANSWERER)";
const SENDER_READ = `  // ANSWER-CC-SIGNER-1121: the brand's stated sales rep (name, role, address), a fact the writer reads: a brief asking
  // to copy them names the right address. None stated = nothing handed.
  const repRead = ctx.vendor.call("brand.sales_rep", { params: { brandId: brandId } });
  const salesRep = repRead.ok && repRead.data && s(repRead.data.salesRepEmail) ? { firstName: s(repRead.data.salesRepFirstName), role: s(repRead.data.salesRepRole), email: s(repRead.data.salesRepEmail).toLowerCase() } : null;
`;
const SENDER_HAND_ANCHOR = " brand: brand, economics: economics,";
const SENDER_HAND = " brand: brand, ...(salesRep ? { salesRep: salesRep } : {}), economics: economics,";

const WRITER_ANCHOR = '    "THE BRAND: " + String(brand.name || "") + (s(economics.name) ? ". What we sell: " + economics.name : ""),\n';
const WRITER_LINE =
  WRITER_ANCHOR +
  '    ...(a.salesRep && s(a.salesRep.email) ? ["THE BRAND\'S SALES REP (a person of the brand, never the person you answer): " + [s(a.salesRep.firstName), s(a.salesRep.role)].filter(Boolean).join(", ") + ", " + s(a.salesRep.email)] : []),\n';

function once(code: string, anchor: string, what: string): number {
  const at = code.indexOf(anchor);
  if (at < 0 || code.indexOf(anchor, at + 1) >= 0) throw new Error(`answer-cc-signer: the ${what} line is not found exactly once: nothing generated`);
  return at;
}

/** The stored sender, handing the brand's sales rep to its writer. */
export function addSalesRepToSender(code: string): string {
  if (code.includes("ANSWER-CC-SIGNER-1121")) throw new Error("answer-cc-signer: the stored sender already hands the sales rep");
  const a = once(code, SENDER_ANCHOR, "writer section");
  const withRead = code.slice(0, a) + SENDER_READ + code.slice(a);
  const b = once(withRead, SENDER_HAND_ANCHOR, "material");
  return withRead.slice(0, b) + SENDER_HAND + withRead.slice(b + SENDER_HAND_ANCHOR.length);
}

/** The stored writer, stating the handed sales rep as one fact line. */
export function addSalesRepToWriter(code: string): string {
  if (code.includes("THE BRAND'S SALES REP")) throw new Error("answer-cc-signer: the stored writer already reads the sales rep");
  const a = once(code, WRITER_ANCHOR, "brand");
  return code.slice(0, a) + WRITER_LINE + code.slice(a + WRITER_ANCHOR.length);
}
