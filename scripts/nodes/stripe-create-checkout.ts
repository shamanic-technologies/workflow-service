// Windmill node script — calls stripe POST /checkout/create
export async function main(
  lineItems: { priceId: string; quantity: number }[],
  successUrl: string,
  cancelUrl: string,
  mode?: "payment" | "subscription",
  customerId?: string,
  customerEmail?: string,
  metadata?: Record<string, string>,
  discounts?: { coupon?: string; promotionCode?: string }[],
  orgId?: string,
  brandId?: string,
  campaignId?: string,
  runId?: string,
  appId?: string,
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/checkout/create`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
      },
      body: JSON.stringify({
        lineItems, successUrl, cancelUrl, mode, customerId, customerEmail,
        metadata, discounts, orgId, brandId, campaignId, runId, appId,
      }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe createCheckout failed (${response.status}): ${err}`);
  }

  return response.json();
}
