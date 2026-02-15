// Windmill node script — app-level logic, resolves a product to its Stripe product ID
// No external HTTP call — reads from config passed in the DAG
export async function main(
  config: {
    productRegistry: Record<string, { stripeProductId: string; name: string }>;
    productKey: string;
  }
) {
  const product = config.productRegistry[config.productKey];

  if (!product) {
    throw new Error(
      `app.resolveProduct: unknown product key "${config.productKey}". Available: ${Object.keys(config.productRegistry).join(", ")}`
    );
  }

  return {
    stripeProductId: product.stripeProductId,
    name: product.name,
    productKey: config.productKey,
  };
}
