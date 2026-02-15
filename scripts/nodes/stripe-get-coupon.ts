// Windmill node script — calls stripe GET /coupons/:couponId
export async function main(
  config: {
    couponId: string;
  }
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/coupons/${config.couponId}`,
    {
      headers: {
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getCoupon failed (${response.status}): ${err}`);
  }

  return response.json();
}
