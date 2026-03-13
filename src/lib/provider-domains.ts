/**
 * Maps provider names (as returned by key-service) to their primary domain.
 * Used by the dashboard to display provider logos via logo.dev.
 *
 * Add new entries here when a new third-party provider is integrated.
 */
export const PROVIDER_DOMAINS: Record<string, string> = {
  anthropic: "anthropic.com",
  openai: "openai.com",
  apollo: "apollo.io",
  instantly: "instantly.ai",
  stripe: "stripe.com",
  twilio: "twilio.com",
  postmark: "postmarkapp.com",
  firecrawl: "firecrawl.dev",
  ahrefs: "ahrefs.com",
  linkedin: "linkedin.com",
  google: "google.com",
  meta: "meta.com",
};

export interface ProviderWithDomain {
  name: string;
  domain: string | null;
}

/**
 * Enrich a list of provider names with their known domains.
 * Returns null for domain when no mapping exists.
 */
export function enrichProvidersWithDomains(providers: string[]): ProviderWithDomain[] {
  return providers.map((name) => ({
    name,
    domain: PROVIDER_DOMAINS[name] ?? null,
  }));
}
