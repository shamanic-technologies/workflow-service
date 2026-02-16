// Windmill node script — calls client PATCH /anonymous-users/:id
export async function main(
  userId: string,
  firstName?: string,
  lastName?: string,
  phone?: string,
  clerkUserId?: string | null,
  orgId?: string | null,
  metadata?: Record<string, unknown> | null,
) {
  const response = await fetch(
    `${Bun.env.CLIENT_SERVICE_URL!}/anonymous-users/${userId}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.CLIENT_SERVICE_API_KEY!,
      },
      body: JSON.stringify({ firstName, lastName, phone, clerkUserId, orgId, metadata }),
    }
  );

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`client updateUser failed (${response.status}): ${err}`);
  }

  return response.json();
}
