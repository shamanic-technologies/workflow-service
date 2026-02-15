// Windmill node script — calls client GET /anonymous-users?appId=...
export async function main(
  config: {
    appId: string;
    limit?: number;
    offset?: number;
  }
) {
  const params = new URLSearchParams({ appId: config.appId });
  if (config.limit) params.set("limit", String(config.limit));
  if (config.offset) params.set("offset", String(config.offset));

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
