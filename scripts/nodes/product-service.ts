// MOCK — product-service not yet deployed
export async function main(
  config: {
    action: "get" | "register";
  },
  productInstanceId?: string,
  registrationData?: Record<string, unknown>
) {
  // TODO: Replace with real product-service call when deployed
  console.log(`[MOCK] Product service ${config.action}`, { productInstanceId, registrationData });
  return { success: true, product: { id: productInstanceId ?? "pi_webinar_001" } };
}
