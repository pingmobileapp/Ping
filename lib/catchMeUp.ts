import { SupabaseClient } from '@supabase/supabase-js';

const DIGEST_WINDOW_DAYS = 7;

type DigestPayload = {
  upcoming_events: { title: string; date: string; my_rsvp: string }[];
  unclaimed_items: { event_title: string; item_name: string }[];
  unread_notifications: { title: string; body: string }[];
};

async function fetchDigestData(supabase: SupabaseClient, userId: string): Promise<DigestPayload> {
  const now = new Date();
  const windowEnd = new Date(now.getTime() + DIGEST_WINDOW_DAYS * 24 * 60 * 60000);

  const [{ data: inviteeRows, error: inviteeError }, { data: notifRows, error: notifError }] = await Promise.all([
    supabase.from('invitees').select('rsvp_status, events(id, title, event_date)').eq('user_id', userId),
    supabase
      .from('notifications')
      .select('title, body')
      .eq('recipient_id', userId)
      .is('read_at', null)
      .lte('created_at', now.toISOString())
      .order('created_at', { ascending: false })
      .limit(10),
  ]);
  if (inviteeError) console.error('Error fetching invitees for digest:', inviteeError);
  if (notifError) console.error('Error fetching notifications for digest:', notifError);

  const upcoming = (inviteeRows || [])
    .filter((r: any) => {
      if (!r.events) return false;
      const d = new Date(r.events.event_date);
      return d >= now && d <= windowEnd;
    })
    .map((r: any) => ({ id: r.events.id as string, title: r.events.title as string, date: r.events.event_date as string, my_rsvp: r.rsvp_status as string }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const upcomingEventIds = upcoming.map((e) => e.id);
  let unclaimedItems: { event_title: string; item_name: string }[] = [];
  if (upcomingEventIds.length > 0) {
    const { data: itemRows, error: itemError } = await supabase
      .from('items')
      .select('name, quantity_needed, events(title), item_claims(quantity)')
      .in('event_id', upcomingEventIds);
    if (itemError) console.error('Error fetching items for digest:', itemError);
    unclaimedItems = (itemRows || [])
      .filter((it: any) => (it.item_claims || []).reduce((sum: number, c: any) => sum + c.quantity, 0) < it.quantity_needed)
      .map((it: any) => ({ event_title: it.events?.title || 'an event', item_name: it.name }));
  }

  return {
    upcoming_events: upcoming.map(({ title, date, my_rsvp }) => ({ title, date, my_rsvp })),
    unclaimed_items: unclaimedItems,
    unread_notifications: (notifRows || []).map((n) => ({ title: n.title, body: n.body })),
  };
}

export async function generateCatchMeUp(supabase: SupabaseClient, userId: string): Promise<string> {
  const payload = await fetchDigestData(supabase, userId);

  const { data, error } = await supabase.functions.invoke('catch-me-up', { body: payload });
  if (error) throw error;

  return data?.summary || "You're all caught up.";
}
