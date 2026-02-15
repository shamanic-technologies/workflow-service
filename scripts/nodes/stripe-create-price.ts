// Windmill node script — calls stripe POST /prices/create
export async function main(
  config: {
    productId: string;
    unitAmountInCents: number;
    currency?: string;
    recurring?: { interval: "day" | "week" | "month" | "year"; intervalCount?: number };
    metadata?: Record<string, string>;
  }
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/prices/create`,
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
    throw new Error(`stripe createPrice failed (${response.status}): ${err}`);
  }

  return response.json();
}
