// Windmill node script — calls transactional-email POST /stats
export async function main(
  orgId?: string,
  userId?: string,
  eventType?: string,
  serviceEnvs?: Record<string, string>,
  runId?: string,
) {
  const baseUrl = serviceEnvs?.["TRANSACTIONAL_EMAIL_SERVICE_URL"] ?? Bun.env.TRANSACTIONAL_EMAIL_SERVICE_URL;
  const apiKey = serviceEnvs?.["TRANSACTIONAL_EMAIL_SERVICE_API_KEY"] ?? Bun.env.TRANSACTIONAL_EMAIL_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("TRANSACTIONAL_EMAIL_SERVICE_URL is not set");
  if (!apiKey) throw new Error("TRANSACTIONAL_EMAIL_SERVICE_API_KEY is not set");

  const reqHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
  };
  if (orgId) reqHeaders["x-org-id"] = orgId;
  if (userId) reqHeaders["x-user-id"] = userId;
  if (runId) reqHeaders["x-run-id"] = runId;

  const response = await fetch(
    `${baseUrl}/stats`,
    {
      method: "POST",
      headers: reqHeaders,
      body: JSON.stringify({ orgId, userId, eventType }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`transactional-email getStats failed (${response.status}): ${err}`);
  }

  return response.json();
}
