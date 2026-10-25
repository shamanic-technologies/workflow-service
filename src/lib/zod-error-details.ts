/**
 * The `details` body of a 400 "Validation error", in the wire shape every caller has always read:
 * `{ issues: [...], name: "ZodError" }`. zod 3 serialised a ZodError to exactly that; zod 4's
 * ZodError serialises to `{ name, message: "<issues as a JSON string>" }`, so passing the error
 * object straight to `res.json` would change the API contract. Always go through this helper.
 */
export function zodErrorDetails(err: unknown): { issues: unknown[]; name: string } {
  const issues = (err as { issues?: unknown }).issues;
  return { issues: Array.isArray(issues) ? issues : [], name: "ZodError" };
}
