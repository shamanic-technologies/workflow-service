// Windmill node script — app-level logic, resolves a discount/coupon for a product+context combo
// No external HTTP call — reads from config passed in the DAG
export async function main(
  config: {
    discountRegistry: Record<string, { stripeCouponId: string; name: string; percentOff?: number }>;
    discountKey: string;
  }
) {
  const discount = config.discountRegistry[config.discountKey];

  if (!discount) {
    throw new Error(
      `app.resolveDiscount: unknown discount key "${config.discountKey}". Available: ${Object.keys(config.discountRegistry).join(", ")}`
    );
  }

  return {
    stripeCouponId: discount.stripeCouponId,
    name: discount.name,
    percentOff: discount.percentOff,
    discountKey: config.discountKey,
  };
}
