import freeDomainsJson from "./email/free-domains.json" with { type: "json" };

// Set lookup is O(1); list size is small (~50) so memory cost is negligible.
const FREE_DOMAINS = new Set<string>(
  (freeDomainsJson as { domains: string[] }).domains.map((d) => d.toLowerCase())
);

// Accepts either a bare domain ("gmail.com") or a full email ("alice@gmail.com").
// Per dec-7: free-domain accounts can exist but cannot enable auto-grouping.
export function isFreeEmailDomain(input: string): boolean {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return false;
  const domain = trimmed.includes("@") ? trimmed.split("@")[1] : trimmed;
  if (!domain) return false;
  return FREE_DOMAINS.has(domain);
}

// Exposed for routes that need to surface the underlying list to the UI (e.g., for
// admin-side messaging like "domain X is on the free list").
export function getFreeEmailDomains(): readonly string[] {
  return Array.from(FREE_DOMAINS).sort();
}
