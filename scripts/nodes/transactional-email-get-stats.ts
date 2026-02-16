// Windmill node script — calls transactional-email POST /stats
export async function main(
  appId?: string,
  clerkOrgId?: string,
  clerkUserId?: string,
  eventType?: string,
) {
  const response = await fetch(
    `${Bun.env.LIFECYCLE_EMAILS_URL!}/stats`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.LIFECYCLE_EMAILS_API_KEY!,
      },
      body: JSON.stringify({ appId, clerkOrgId, clerkUserId, eventType }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`transactional-email getStats failed (${response.status}): ${err}`);
  }

  return response.json();
}
