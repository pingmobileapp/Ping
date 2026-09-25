// "Greater Zion Stadium, Saint George, UT" -> "Saint George, UT". Nominatim
// often has no entry for a venue name but always knows the city, and a
// city-level fix is plenty for the radius check - without one, a row with
// no coordinates slips past Discover's distance filter entirely.
// Needs at least "place, city, state" so a bare "Venue, City" isn't
// mistaken for a city/state pair.
export function cityStateOf(location: string): string | null {
  const parts = location.split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return null;
  return parts.slice(-2).join(', ');
}
