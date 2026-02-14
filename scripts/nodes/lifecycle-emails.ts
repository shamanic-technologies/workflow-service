// Windmill node script — calls lifecycle-emails POST /send
export async function main(
  config: {
    appId: string;
    eventType: string;
    dedupKey?: string;
  },
  recipientEmail: string,
  metadata?: Record<string, unknown>,
  context?: {
    orgId?: string;
  }
) {
  const response = await fetch(
    `${Bun.env.LIFECYCLE_EMAILS_URL}/send`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.LIFECYCLE_EMAILS_API_KEY!,
      },
      body: JSON.stringify({
        appId: config.appId,
        eventType: config.eventType,
        recipientEmail,
        dedupKey: config.dedupKey,
        metadata,
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`lifecycle-emails failed: ${response.statusText}`);
  }

  return response.json();
}
