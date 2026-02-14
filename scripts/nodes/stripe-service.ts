// MOCK — stripe-service not yet deployed
export async function main(
  config: {
    action: "create_checkout" | "get_payment";
  },
  sessionId?: string,
  data?: Record<string, unknown>
) {
  // TODO: Replace with real stripe-service call when deployed
  console.log(`[MOCK] Stripe service ${config.action}`, { sessionId, data });
  return { success: true, session: { id: sessionId ?? `cs_mock_${Date.now()}`, ...data } };
}
