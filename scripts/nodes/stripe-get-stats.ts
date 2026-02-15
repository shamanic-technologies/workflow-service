// Windmill node script — calls stripe POST /stats
export async function main(
  config: {
    runIds?: string[];
    clerkOrgId?: string;
    brandId?: string;
    appId?: string;
    campaignId?: string;
  }
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/stats`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
      },
      body: JSON.stringify(config),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getStats failed (${response.status}): ${err}`);
  }

  return response.json();
}
