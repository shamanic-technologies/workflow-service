// Windmill node script — calls stripe GET /prices/by-product/:productId
export async function main(
  productId: string,
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/prices/by-product/${productId}`,
    {
      headers: {
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getPricesByProduct failed (${response.status}): ${err}`);
  }

  return response.json();
}
