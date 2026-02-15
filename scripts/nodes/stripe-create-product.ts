// Windmill node script — calls stripe POST /products/create
export async function main(
  config: {
    name: string;
    description?: string;
    id?: string;
    metadata?: Record<string, string>;
  }
) {
  const response = await fetch(
    `${Bun.env.STRIPE_SERVICE_URL!}/products/create`,
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
    throw new Error(`stripe createProduct failed (${response.status}): ${err}`);
  }

  return response.json();
}
