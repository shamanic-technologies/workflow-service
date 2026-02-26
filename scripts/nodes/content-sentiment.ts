// Windmill node script — calls reply-qualification POST /qualify
export async function main(
  emailContent: string,
  context: {
    orgId: string;
  },
  serviceEnvs?: Record<string, string>,
) {
  const baseUrl = serviceEnvs?.["REPLY_QUALIFICATION_URL"] ?? Bun.env.REPLY_QUALIFICATION_URL;
  const apiKey = serviceEnvs?.["REPLY_QUALIFICATION_API_KEY"] ?? Bun.env.REPLY_QUALIFICATION_API_KEY;
  if (!baseUrl) throw new Error("REPLY_QUALIFICATION_URL is not set");
  if (!apiKey) throw new Error("REPLY_QUALIFICATION_API_KEY is not set");

  const response = await fetch(
    `${baseUrl}/qualify`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "x-org-id": context.orgId,
      },
      body: JSON.stringify({ content: emailContent }),
    }
  );

  const data = await response.json();
  return { sentiment: data.sentiment, category: data.category };
}
