// Windmill node script — calls client POST /anonymous-users
export async function main(
  config: {
    appId: string;
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    orgId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  const response = await fetch(
    `${Bun.env.CLIENT_SERVICE_URL!}/anonymous-users`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.CLIENT_SERVICE_API_KEY!,
      },
      body: JSON.stringify(config),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client createUser failed (${response.status}): ${err}`);
  }

  return response.json();
}
