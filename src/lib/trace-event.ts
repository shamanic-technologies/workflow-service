export async function traceEvent(
  runId: string,
  payload: {
    service: string;
    event: string;
    detail?: string;
    level?: "info" | "warn" | "error";
    data?: Record<string, unknown>;
  },
  headers: Record<string, string | string[] | undefined>
): Promise<void> {
  const url = process.env.RUNS_SERVICE_URL;
  const apiKey = process.env.RUNS_SERVICE_API_KEY;
  if (!url || !apiKey) {
    console.error("[workflow-service] RUNS_SERVICE_URL or RUNS_SERVICE_API_KEY not set, skipping trace");
    return;
  }
  try {
    const fetchHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
    };
    for (const key of ["x-org-id", "x-user-id", "x-brand-id", "x-campaign-id", "x-workflow-slug", "x-feature-slug"] as const) {
      const value = headers[key];
      if (typeof value === "string") {
        fetchHeaders[key] = value;
      }
    }
    await fetch(`${url}/v1/runs/${runId}/events`, {
      method: "POST",
      headers: fetchHeaders,
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error("[workflow-service] Failed to trace event:", err);
  }
}
