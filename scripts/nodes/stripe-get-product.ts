// Windmill node script — calls stripe GET /products/:productId
export async function main(
  productId: string,
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/products/${productId}`,
    {
      headers: {
        "X-API-Key": Bun.env.STRIPE_SERVICE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`stripe getProduct failed (${response.status}): ${err}`);
  }

  return response.json();
}
