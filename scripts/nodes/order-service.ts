// MOCK — order-service not yet deployed
export async function main(
  action: "create" | "get" | "update",
  orderId?: string,
  data?: Record<string, unknown>
) {
  // TODO: Replace with real order-service call when deployed
  console.log(`[MOCK] Order service ${action}`, { orderId, data });
  return { success: true, order: { id: orderId ?? `ord_mock_${Date.now()}`, ...data } };
}
