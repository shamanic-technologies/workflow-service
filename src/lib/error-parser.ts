/**
 * Parses raw Windmill error results into clean, frontend-friendly error info.
 *
 * Windmill errors come as JSON like:
 *   {"error":{"message":"POST lead/buffer/next failed (500): {\"error\":\"Internal server error\"}","name":"Error","stack":"...","step_id":"fetch_lead"}}
 *
 * Service errors are often deeply nested:
 *   "runs-service POST /v1/runs/.../costs failed: 502 - {\"error\":\"billing-service unavailable: billing-service returned 400\"}"
 */

export interface ParsedError {
  /** Which workflow step failed (e.g. "fetch_lead", "send_email") */
  failedStep: string | null;
  /** Clean, human-readable error message (no stack traces) */
  message: string;
  /** The innermost root cause extracted from nested service error chains */
  rootCause: string;
}

/**
 * Extract the innermost error message from nested service error chains.
 *
 * Handles patterns like:
 *   "runs-service POST /v1/runs/.../costs failed: 502 - {\"error\":\"billing-service unavailable: billing-service returned 400\"}"
 *   → "billing-service unavailable: billing-service returned 400"
 */
export function extractRootCause(message: string): string {
  let current = message;
  const maxDepth = 10;

  for (let i = 0; i < maxDepth; i++) {
    // Try to find a "failed: STATUS - {...}" pattern and extract the JSON
    const failedMatch = current.match(/failed:\s*\d+\s*-\s*(\{.+\})\s*$/);
    if (failedMatch) {
      try {
        const parsed = JSON.parse(failedMatch[1]);
        if (typeof parsed.error === "string") {
          current = parsed.error;
          continue;
        }
      } catch {
        // Might be escaped JSON — try unescaping once
        try {
          const unescaped = failedMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const parsed = JSON.parse(unescaped);
          if (typeof parsed.error === "string") {
            current = parsed.error;
            continue;
          }
        } catch {
          // Not valid JSON even after unescaping
        }
      }
    }

    // Try to find an embedded JSON object with an "error" field
    const jsonMatch = current.match(/\{[^{}]*"error"\s*:\s*"([^"]+)"[^{}]*\}/);
    if (jsonMatch) {
      current = jsonMatch[1];
      continue;
    }

    break;
  }

  return current;
}

/**
 * Strip stack traces from an error message.
 * Removes lines starting with "at " or "    at ".
 */
function stripStackTrace(message: string): string {
  return message
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("at "))
    .join("\n")
    .trim();
}

/**
 * Parse a raw Windmill error result into a clean, structured error.
 */
export function parseWindmillError(raw: string | null | undefined): ParsedError {
  if (!raw) {
    return { failedStep: null, message: "Unknown error", rootCause: "Unknown error" };
  }

  // Try to parse as JSON (Windmill's typical format)
  try {
    const parsed = JSON.parse(raw);

    // Format: {"error": {"message": "...", "step_id": "...", "stack": "..."}}
    if (parsed?.error && typeof parsed.error === "object") {
      const errorObj = parsed.error;
      const stepId = errorObj.step_id ?? null;
      const rawMessage = typeof errorObj.message === "string" ? errorObj.message : JSON.stringify(errorObj.message ?? "Unknown error");
      const message = stripStackTrace(rawMessage);
      const rootCause = extractRootCause(message);

      return { failedStep: stepId, message, rootCause };
    }

    // Format: {"error": "some string"}
    if (typeof parsed?.error === "string") {
      const message = stripStackTrace(parsed.error);
      return { failedStep: null, message, rootCause: extractRootCause(message) };
    }

    // Format: {"message": "...", "step_id": "..."}
    if (typeof parsed?.message === "string") {
      const message = stripStackTrace(parsed.message);
      return {
        failedStep: parsed.step_id ?? null,
        message,
        rootCause: extractRootCause(message),
      };
    }
  } catch {
    // Not JSON — treat as plain string
  }

  // Plain string error
  const message = stripStackTrace(raw);
  return { failedStep: null, message, rootCause: extractRootCause(message) };
}
