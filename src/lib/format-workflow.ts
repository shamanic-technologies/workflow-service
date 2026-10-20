import type { workflows } from "../db/schema.js";
import type { DAG } from "./dag-validator.js";
import { summarizeContentGeneration } from "./content-generation-summary.js";
import { servedDeprecation } from "./deprecation.js";

/** The workflow shape every workflow read and write returns. */
export function formatWorkflow(w: typeof workflows.$inferSelect) {
  const { deprecationReason: _reason, deprecatedBy: _by, deprecatedAt: _at, ...rest } = w;
  return {
    ...rest,
    // DEPRECATION-REASON-1020: why / who / when, null while the row is executable.
    deprecation: servedDeprecation(w),
    // Derived, never stored: the content model + prompt template a consumer
    // wants to display per row live inside the DAG, and resolving them here
    // saves every reader from downloading N DAGs and reimplementing "which node
    // is the content call". Null whenever the DAG does not state them.
    ...summarizeContentGeneration(w.dag as DAG | null),
    createdAt: w.createdAt?.toISOString() ?? null,
    updatedAt: w.updatedAt?.toISOString() ?? null,
  };
}
