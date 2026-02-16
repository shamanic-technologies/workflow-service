// Windmill node script — calls stripe GET /products/:productId
export async function main(
  appId: string,
  productId: string,
) {
  const baseUrl = Bun.env.STRIPE_SERVICE_URL;
  const apiKey = Bun.env.STRIPE_SERVICE_API_KEY;
  if (!baseUrl) throw new Error("STRIPE_SERVICE_URL is not set");
  if (!apiKey) throw new Error("STRIPE_SERVICE_API_KEY is not set");

  const url = new URL(`${baseUrl}/products/${productId}`);
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
    throw new Error(`stripe getProduct failed (${response.status}): ${err}`);
  }

  return response.json();
}
