// Windmill node script — calls lead-service POST /buffer/next
export async function main(
  config: {
    source?: string;
    searchParams?: Record<string, unknown>;
  },
  context: {
    orgId: string;
    brandId: string;
    campaignId: string;
    subrequestId?: string;
    runId: string;
  }
) {
  const response = await fetch(
    `${Bun.env.LEAD_SERVICE_URL}/buffer/next`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": Bun.env.LEAD_SERVICE_API_KEY!,
        "x-clerk-org-id": context.orgId,
      },
      body: JSON.stringify({
        campaignId: context.campaignId,
        brandId: context.brandId,
        parentRunId: context.runId,
        searchParams: config.searchParams,
      }),
    }
  );

  const data = await response.json();
  if (!data.found) throw new Error("No lead found in buffer");
  return { lead: data.lead };
}
