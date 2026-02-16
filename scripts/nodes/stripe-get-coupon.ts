// Windmill node script — calls stripe GET /coupons/:couponId
export async function main(
  appId: string,
  couponId: string,
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const url = new URL(`${baseUrl}/coupons/${couponId}`);
  url.searchParams.set("appId", appId);

  const response = await fetch(
    url.toString(),
    {
      headers: {
        "X-API-Key": apiKey,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getCoupon failed (${response.status}): ${err}`);
  }

  return response.json();
}
