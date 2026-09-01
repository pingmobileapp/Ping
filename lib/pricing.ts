// Shared by Create/EditEventModal (host sets a price), discoverActivities
// (Discover card price label), and EventDetailContent (event detail price)
// - price_cents is the only source of truth; everything else derives from
// it. null/0 means free, same convention discover_capacity.sql uses for
// "no limit" on capacity.

export function dollarsToCents(input: string): number | null {
  const dollars = parseFloat(input.trim());
  if (!Number.isFinite(dollars) || dollars <= 0) return null;
  return Math.round(dollars * 100);
}

export function centsToDollarsInput(cents: number | null | undefined): string {
  return cents ? (cents / 100).toFixed(2) : '';
}

export function formatPrice(cents: number | null | undefined): string {
  return cents && cents > 0 ? `$${(cents / 100).toFixed(2)}` : 'Free';
}
