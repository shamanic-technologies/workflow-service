/**
 * Maps our DAG node types to Windmill script paths.
 * null = native Windmill construct (wait, condition, for-each).
 */
export const NODE_TYPE_REGISTRY: Record<string, string | null> = {
  // Live services
  "lead-service": "f/nodes/lead_service",
  "content-generation": "f/nodes/content_generation",
  "outbound-sending": "f/nodes/outbound_sending",
  "brand-intel": "f/nodes/brand_intel",
  "content-sentiment": "f/nodes/content_sentiment",
  "lifecycle-emails": "f/nodes/lifecycle_emails",
  "client-service": "f/nodes/client_service",

  // Mocked services (not yet deployed)
  "twilio-sms": "f/nodes/twilio_sms",
  "order-service": "f/nodes/order_service",
  "product-service": "f/nodes/product_service",
  "stripe-service": "f/nodes/stripe_service",

  // Stubs (not yet implemented)
  "linkedin-dm": "f/nodes/linkedin_dm",
  "linkedin-connect": "f/nodes/linkedin_connect",
  "linkedin-post": "f/nodes/linkedin_post",
  "google-ads": "f/nodes/google_ads",
  "meta-ads": "f/nodes/meta_ads",

  // Native Windmill constructs
  wait: null,
  condition: null,
  "for-each": null,
};

export function getScriptPath(nodeType: string): string | null {
  if (!(nodeType in NODE_TYPE_REGISTRY)) {
    return undefined as unknown as null;
  }
  return NODE_TYPE_REGISTRY[nodeType];
}

export function isKnownNodeType(nodeType: string): boolean {
  return nodeType in NODE_TYPE_REGISTRY;
}

export function isNativeNode(nodeType: string): boolean {
  return nodeType in NODE_TYPE_REGISTRY && NODE_TYPE_REGISTRY[nodeType] === null;
}
