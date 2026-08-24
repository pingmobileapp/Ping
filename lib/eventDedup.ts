// No stored link ties a Ping to a same-named entry someone's synced
// calendar independently picked up (e.g. a family calendar invite for the
// same real-world gathering) - an external item is treated as a duplicate
// of a Ping, and dropped, when their titles are a reasonably close match
// and they start within 90 minutes of each other. Shared by the Upcoming
// list (app/(tabs)/index.tsx) and Week view (lib/weekTimeline.ts) so this
// rule can't drift out of sync between the two again - it already did
// once, when Week view got this fix and the Upcoming list didn't.
const normalizeTitle = (t: string) => t.trim().toLowerCase();
const titlesLikelyMatch = (a: string, b: string): boolean => {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
};
const MATCH_WINDOW_MS = 90 * 60000;

export function externalItemDuplicatesPing(
  pingEntries: { title: string; start: Date }[],
  external: { title: string; start: Date }
): boolean {
  return pingEntries.some(
    (p) =>
      titlesLikelyMatch(p.title, external.title) &&
      Math.abs(p.start.getTime() - external.start.getTime()) <= MATCH_WINDOW_MS,
  );
}
