import { createHash } from "node:crypto";

/**
 * Recursively sorts object keys to ensure deterministic JSON serialization.
 * Arrays preserve order (element order matters in a DAG).
 */
function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Computes a deterministic SHA-256 hash of a DAG object.
 * Keys are sorted recursively so that `{a:1, b:2}` and `{b:2, a:1}`
 * produce the same hash. Array element order is preserved.
 */
export function computeDAGSignature(dag: unknown): string {
  const canonical = JSON.stringify(canonicalize(dag));
  return createHash("sha256").update(canonical).digest("hex");
}
