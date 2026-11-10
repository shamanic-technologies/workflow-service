/**
 * Pieces every answering workflow shared, moved out of the AI Meeting Booking workflow when it was deleted (MIGRATE-1105
 * S1b: the answering script replaced it). Byte for byte what the old file held.
 */
/** crm-service's WhatsApp send (the brand's linked account). Wired against its served contract. */
export const CRM_WHATSAPP_SEND = { service: "crm", method: "POST", path: "/orgs/whatsapp/messages" } as const;

/**
 * WHO this pipe answers (REPLY-ANY-LEAD-1015, owner 2026-10-15): only the people lead-service holds as PURE
 * PROSPECTS of the brand. Never the owner's personal contacts, the brand's customers, team, investors, partners,
 * suppliers or advisors, even when they write to the brand on a mirrored channel (WhatsApp) and that message is
 * reported as a positive reply. Every follow-up claim of this flow states it on lead-service's claim
 * (`relationships`), and lead-service is the only judge: this flow never re-judges a relationship, it reads the
 * verdict the claim returns (`relationships.refused` = final, the row is stopped there; `relationships.pending` =
 * still owed once the relationship is known). The same value the sourcing serve states for its own policy.
 */
export const ANSWERS_LEADS_ONLY_POLICY = "pure_prospect";

/** The reason lead-service names when it refuses a person who is not a lead of the brand. */
export const NOT_A_LEAD_REASON = "not_a_lead";

/**
 * STEP 2's assembly: what the CLIENT told us, and nothing else.
 *
 * Owner rule (2026-10-11): what we state or promise to a prospect comes only
 * from what the client told us. That is the offer's answers (question/answer
 * pairs) and the offer's and brand's user-fields whose provenance is
 * `confirmed` (a person validated them in the dashboard). A `suggested` field
 * is brand-service's auto-extract prefill off the website, so it is not read,
 * and neither is the website itself: the site-extraction tier this step used
 * to merge in quoted four list prices to a prospect as the client's answer
 * (Shockwavecenters, 2026-10-11). A question nothing here answers escalates,
 * and the client answers it.
 *
 * `neverGive` is not a fact to state: it is the client's list of things we
 * never offer, promise or hint at, each one WHOLE (never a smaller version of
 * it, never "up to"). It is returned apart so the prompt can set it as a limit.
 * `giveForFree` is a fact like any other: what we may offer.
 *
 * Every fact gets an id (E1..) that the draft cites and `ground-draft` checks.
 * Empty values ("Unknown", "", [], null) are dropped, never shown as a blank.
 *
 * An operator PLACEHOLDER is no answer either. brand-service serves offer
 * answers as bare `{question, answer}` pairs with no status or provenance, and
 * Doc Dinners' "How much is it?" / "What is included?" hold
 * "PLACEHOLDER — not a real answer, do not quote this to anyone...". Filed as a
 * fact, a price question would be answered from it. With no field to read,
 * the literal marker (a value opening with the word PLACEHOLDER) is matched, on
 * every source; the pair is WITHHELD — never in the prompt as a fact, listed only
 * as a thing our client has not answered yet, so a question it would have covered
 * escalates. A per-answer status on brand-service's answers read would make this
 * match unnecessary.
 */
export const GATHER_FACTS_CODE = `
export async function main(plan, offerAnswers, offerFields, brandFields) {
  // The brand-scoped read is refused BY DESIGN once a brand sells several
  // offers (409 SEVERAL_OFFERS: "name the offer"); the offer-scoped read above
  // is then the answer, so that one refusal means "no brand-level fields".
  // Every other failure of that read is still an error.
  if (brandFields && brandFields.ok === false) {
    if (brandFields.status === 409 && String(brandFields.error ?? "").includes("SEVERAL_OFFERS")) {
      console.log("[facts] the brand sells several offers: brand-level fields are not read, the offer's own are");
      brandFields = null;
    } else {
      throw new Error("brand user-fields read failed (" + String(brandFields.status) + "): " + String(brandFields.error ?? ""));
    }
  }
  const isEmpty = (v) => {
    if (v === null || v === undefined) return true;
    if (typeof v === "string") return v.trim() === "" || /^unknown$/i.test(v.trim());
    if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  };
  const isPlaceholder = (v) => typeof v === "string" && /^\\s*placeholder\\b/i.test(v);
  const render = (v) => {
    if (typeof v === "string") return v.trim();
    if (Array.isArray(v)) return v.filter((x) => !isEmpty(x)).map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("; ");
    return JSON.stringify(v);
  };

  const exact = [];
  const neverGive = [];
  const withheld = [];
  const unconfirmed = [];
  const addExact = (f) => exact.push({ id: "E" + (exact.length + 1), ...f });

  for (const a of offerAnswers?.answers ?? []) {
    if (isEmpty(a?.question) || isEmpty(a?.answer)) continue;
    if (isPlaceholder(a.answer)) {
      withheld.push({ source: "offer-answers", label: String(a.question).trim() });
      continue;
    }
    addExact({ source: "offer-answers", label: String(a.question).trim(), value: String(a.answer).trim() });
  }

  const seen = new Set();
  for (const [scope, read] of [["offer-user-fields", offerFields], ["brand-user-fields", brandFields]]) {
    for (const [key, field] of Object.entries(read?.fields ?? {})) {
      if (isEmpty(field?.value)) continue;
      // Not confirmed = the site's prefill, which nobody told us.
      if (field?.provenance !== "confirmed") {
        unconfirmed.push(scope + ":" + key);
        continue;
      }
      const value = render(field.value);
      if (isPlaceholder(value)) {
        withheld.push({ source: scope, label: key });
        continue;
      }
      if (key === "neverGive") {
        for (const item of Array.isArray(field.value) ? field.value : [field.value]) {
          if (isEmpty(item)) continue;
          const text = render(item);
          if (!neverGive.includes(text)) neverGive.push(text);
        }
        continue;
      }
      if (seen.has(key + "::" + value)) continue;
      seen.add(key + "::" + value);
      addExact({ source: scope, label: key, value });
    }
  }

  const questions = (plan?.questions ?? []).map((q) => ({ key: q.key, question: q.question }));

  const facts = { questions, exact, neverGive, withheld };
  if (withheld.length) {
    console.error("[ai-meeting-booking] withheld operator PLACEHOLDER answer(s), not facts: " + JSON.stringify(withheld));
  }
  if (unconfirmed.length) {
    console.log("[ai-meeting-booking] not used, the client never confirmed them (site prefill): " + unconfirmed.join(", "));
  }
  console.log("[ai-meeting-booking] what our client told us, the only facts the reply may state: " + JSON.stringify(facts));
  return facts;
}
`.trim();

/**
 * Output budget of EVERY chat-service `/complete` step in this DAG.
 *
 * The configured model is a THINKING model (`pro` resolves to Gemini 3.1 Pro),
 * and its thought tokens are billed against the same `maxOutputTokens` as the
 * JSON it returns. A cap sized for the JSON alone (800 on list-questions) left
 * the model no room: chat-service logged `MAX_TOKENS hit | tokensOutput=786`
 * and failed loud, so a prospect who replied with interest (Legistai,
 * 2026-10-05) was never answered, every retry dying the same way. chat-service
 * reserves cost on this cap and bills what was actually produced, so a
 * generous cap costs nothing on a run that does not use it. Do not size a
 * step's cap from its expected JSON length; a test pins every chat step at or
 * above this floor.
 */
export const CHAT_STEP_MAX_TOKENS = 16_000;
