// Windmill node script — calls brand-service
export async function main(
  action: string,
  context: {
    orgId: string;
    brandId: string;
  }
) {
  const response = await fetch(
    `${Bun.env.BRAND_SERVICE_URL}/brands/${context.brandId}`,
    {
      headers: {
        "x-api-key": Bun.env.BRAND_SERVICE_API_KEY!,
        "x-clerk-org-id": context.orgId,
      },
    }
  );

  const data = await response.json();
  return { brand: data };
}
