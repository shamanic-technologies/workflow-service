// Windmill node script — calls client GET /anonymous-users?appId=...
export async function main(
  appId: string,
  limit?: number,
  offset?: number,
) {
  const params = new URLSearchParams({ appId });
  if (limit) params.set("limit", String(limit));
  if (offset) params.set("offset", String(offset));

  const response = await fetch(
    `${Bun.env.CLIENT_SERVICE_URL!}/anonymous-users?${params}`,
    {
      headers: {
        "x-api-key": Bun.env.CLIENT_SERVICE_API_KEY!,
      },
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client getUsers failed (${response.status}): ${err}`);
  }

  return response.json();
}
