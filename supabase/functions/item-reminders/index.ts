import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Runs once a day (see supabase/item_reminders_cron.sql) and notifies
// everyone who claimed a "what to bring" item for an event happening
// tomorrow, listing exactly what they signed up for - real request,
// 2026-09-12: a host noticed nothing reminded her (or anyone else) what
// they'd claimed the day before the event.
//
// Deliberately server-side/scheduled rather than piggybacking on the
// existing per-user "Remind me before" feature (lib/eventReminders.ts) -
// that one is a purely local, on-device notification the recipient has to
// have manually turned on, with generic "your event is coming up" text.
// This has to reach everyone who claimed something regardless of whether
// they set a personal reminder, with content specific to what they
// individually claimed.
serve(async (req) => {
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // "Tomorrow" as a plain UTC calendar day - the same DST-unaware
    // approximation the cron schedule itself already accepts (see
    // item_reminders_cron.sql's own comment on this). Not worth the
    // complexity of a real per-user timezone lookup for a heads-up that's
    // already imprecise by nature - it fires once, a day out, not to the
    // minute.
    const tomorrowStart = new Date();
    tomorrowStart.setUTCHours(0, 0, 0, 0);
    tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
    const tomorrowEnd = new Date(tomorrowStart.getTime() + 24 * 60 * 60000);

    const { data: events, error: eventsError } = await admin
      .from('events')
      .select('id, title')
      .eq('status', 'sent')
      .gte('event_date', tomorrowStart.toISOString())
      .lt('event_date', tomorrowEnd.toISOString());
    if (eventsError) throw new Error(`fetch events: ${eventsError.message}`);

    let remindersSent = 0;

    for (const event of events || []) {
      const { data: items } = await admin.from('items').select('id, name').eq('event_id', event.id);
      if (!items || items.length === 0) continue;
      const itemNameById = new Map(items.map((i) => [i.id, i.name as string]));

      const { data: claims } = await admin
        .from('item_claims')
        .select('item_id, invitee_id, note')
        .in(
          'item_id',
          items.map((i) => i.id)
        );
      if (!claims || claims.length === 0) continue;

      const { data: invitees } = await admin
        .from('invitees')
        .select('id, user_id')
        .in('id', Array.from(new Set(claims.map((c) => c.invitee_id))));
      const userIdByInviteeId = new Map((invitees || []).map((i) => [i.id, i.user_id as string | null]));

      // Groups by who's bringing it, not by item - one notification per
      // person listing everything they claimed for this event, not one
      // per item (nobody wants 4 separate pings for 4 things they signed
      // up for on the same Ping).
      const itemLabelsByUserId = new Map<string, string[]>();
      for (const claim of claims) {
        const userId = userIdByInviteeId.get(claim.invitee_id);
        // No linked account (a non-app invitee) means no notification row
        // or push token to reach them through at all - nothing to do.
        if (!userId) continue;
        const itemName = itemNameById.get(claim.item_id);
        if (!itemName) continue;
        const label = claim.note ? `${itemName} (${claim.note})` : itemName;
        const list = itemLabelsByUserId.get(userId) || [];
        list.push(label);
        itemLabelsByUserId.set(userId, list);
      }

      for (const [userId, labels] of itemLabelsByUserId) {
        const title = '🛒 Reminder: bring your items tomorrow!';
        const body = `${labels.join(', ')} — for ${event.title}`;

        const { error: notifyError } = await admin.from('notifications').insert([
          { recipient_id: userId, type: 'event_reminder', event_id: event.id, title, body },
        ]);
        if (notifyError) console.error('Error inserting item reminder notification:', notifyError);

        await admin.functions
          .invoke('send-push', {
            body: { user_ids: [userId], title, body, data: { eventId: event.id, type: 'event_reminder' } },
          })
          .catch((err) => console.error('Push notification failed:', err));

        remindersSent++;
      }
    }

    return new Response(JSON.stringify({ remindersSent }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
