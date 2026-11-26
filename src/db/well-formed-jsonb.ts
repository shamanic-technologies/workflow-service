import { PgJsonb } from "drizzle-orm/pg-core";

/**
 * MON-XPOST-SCRIPT-1126-WF: Postgres jsonb refuses a string holding a LONE surrogate (`"\ud83d"` alone: "invalid
 * input syntax for type json"), and JSON.stringify writes exactly that for half an emoji. A script that cut a text
 * at a fixed length (`.slice(0, 2000)` landing inside an emoji) made a Unit no row could store: its script_runs row
 * stayed `running`, the asking script stopped, the campaign failed every run.
 *
 * One guard at the storage boundary, for every jsonb write of this service: each string (values AND object keys) is
 * made well-formed before it is serialized, a lone surrogate becoming U+FFFD. A valid pair is untouched, so a
 * well-formed value serializes byte for byte as before.
 */
/** A high surrogate with no low one after it, or a low one with no high one before it. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The string with every lone surrogate replaced by U+FFFD (String.prototype.toWellFormed, ES2024). */
export function wellFormedString(s: string): string {
  return s.replace(LONE_SURROGATE, "\uFFFD");
}

export function wellFormedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (typeof v === "string") return wellFormedString(v);
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).some((k) => wellFormedString(k) !== k)) {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) out[wellFormedString(k)] = val;
      return out;
    }
    return v;
  });
}

/** drizzle's jsonb column serializes with JSON.stringify: every jsonb column of the schema goes through the guard. */
(PgJsonb.prototype as unknown as { mapToDriverValue: (value: unknown) => string }).mapToDriverValue = wellFormedJson;
