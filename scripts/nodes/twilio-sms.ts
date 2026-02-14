// MOCK — twilio-service not yet deployed
export async function main(
  config: Record<string, unknown>,
  to: string,
  body: string,
  metadata?: Record<string, unknown>
) {
  // TODO: Replace with real twilio-service call when deployed
  console.log(`[MOCK] Sending SMS to ${to}: ${body}`);
  return {
    sid: `SM_mock_${Date.now()}`,
    status: "sent",
    to,
    body,
  };
}
