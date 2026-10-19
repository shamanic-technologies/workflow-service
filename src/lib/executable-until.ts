import { sql } from "drizzle-orm";
import { workflows } from "../db/schema.js";

// WF-VERSION-DATES-1019: `executable_until` is the instant a version stopped being
// executable (version deprecated OR dynasty retired), NULL while it still runs. A fleet
// reader (features-service rebuilding past days' indexes) reads it to know what could
// run at the end of a given day; cost rows keep landing long after a retirement, so
// they cannot answer that.

export type ExecutableUntilSource = "recorded" | "successor_created" | "last_update";

/**
 * `.set()` fields for a write that makes a row non-executable. Keeps an earlier stop
 * (a version already deprecated whose dynasty is retired later stopped running at the
 * FIRST transition), else records now.
 */
export function stopExecutable() {
  return {
    executableUntil: sql`COALESCE(${workflows.executableUntil}, now())`,
    executableUntilSource: sql`COALESCE(${workflows.executableUntilSource}, 'recorded')`,
  };
}

/** `.set()` fields for a write that makes a row executable again. */
export const STILL_EXECUTABLE = { executableUntil: null, executableUntilSource: null } as const;

/** Fields for an INSERT: a row born under a retired dynasty is non-executable from birth. */
export function executableUntilAtBirth(executable: boolean, now: Date) {
  return executable
    ? { executableUntil: null, executableUntilSource: null }
    : { executableUntil: now, executableUntilSource: "recorded" as const };
}
