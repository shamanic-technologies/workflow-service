// Windmill node script — calls reply-qualification POST /qualify
export async function main(
  config: Record<string, unknown>,
  emailContent: string,
  context: {
    orgId: string;
  }
) {
  const response = await fetch(
    `${Bun.env.REPLY_QUALIFICATION_URL}/qualify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.REPLY_QUALIFICATION_API_KEY!,
        "x-clerk-org-id": context.orgId,
      },
      body: JSON.stringify({ content: emailContent, ...config }),
    }
  );

  const data = await response.json();
  return { sentiment: data.sentiment, category: data.category };
}
