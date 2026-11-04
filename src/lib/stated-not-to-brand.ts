/**
 * crm-service's WhatsApp refusal (send AND reach check) for a person the brand's user stated is NOT someone of the
 * brand (a people correction; crm-service v0.112.0, DUALIST-WA-SILENCE-1104, owner 2026-11-04: « On le tag dans
 * distribute.you comme PAS client de notre marque donc il ne recevra pas de réponse de la part de nous »).
 *
 * About the PERSON, never brand-side, and never a failure: every WhatsApp-sending workflow ends that person's step
 * quietly. Nothing is sent to them on ANY channel by that run (a follow-up never falls back to email for them), no
 * retry, no rep or owner alert, and a run answering their occurrence states `personNotAdmitted` (campaign-service
 * counts it as not owed, never as an unsent answer). It lasts until the brand undoes the statement: crm-service
 * then answers reachable again.
 */
export const STATED_NOT_TO_BRAND_CODE = "stated_not_to_brand";
