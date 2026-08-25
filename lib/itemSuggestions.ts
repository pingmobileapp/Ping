import { SupabaseClient } from '@supabase/supabase-js';

// Events this user actually organized (hosted, or co-hosted) - what they
// attended as a guest doesn't say anything about what THEY tend to bring
// as an organizer, so that's deliberately excluded here.
export async function fetchPastEventItems(
  supabase: SupabaseClient,
  userId: string
): Promise<{ title: string; items: string[] }[]> {
  const [{ data: hostedEvents, error: hostedError }, { data: coHostRows, error: coHostError }] = await Promise.all([
    supabase.from('events').select('id, title, items(name)').eq('host_id', userId).order('event_date', { ascending: false }).limit(15),
    supabase.from('event_hosts').select('event_id').eq('user_id', userId),
  ]);
  if (hostedError) console.error('Error loading past hosted events:', hostedError);
  if (coHostError) console.error('Error loading co-hosted events:', coHostError);

  const coHostedEventIds = (coHostRows || []).map((r) => r.event_id);
  let coHostedEvents: any[] = [];
  if (coHostedEventIds.length > 0) {
    const { data, error } = await supabase
      .from('events')
      .select('id, title, items(name)')
      .in('id', coHostedEventIds)
      .order('event_date', { ascending: false })
      .limit(15);
    if (error) console.error('Error loading co-hosted event items:', error);
    coHostedEvents = data || [];
  }

  const seen = new Set<string>();
  const combined: { title: string; items: string[] }[] = [];
  for (const e of [...(hostedEvents || []), ...coHostedEvents]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    const itemNames = (e.items || []).map((it: { name: string }) => it.name);
    if (itemNames.length > 0) combined.push({ title: e.title, items: itemNames });
  }
  return combined;
}

export async function suggestItems(
  supabase: SupabaseClient,
  userId: string,
  eventTitle: string
): Promise<string[]> {
  const pastEvents = await fetchPastEventItems(supabase, userId);

  const { data, error } = await supabase.functions.invoke('suggest-items', {
    body: { event_title: eventTitle, past_events: pastEvents },
  });
  if (error) throw error;

  return (data?.items || []).filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0);
}
