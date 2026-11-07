import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { rejectUnlessCron } from '../_shared/cron.ts';

// Runs every 5 minutes (see supabase/ai_reminders.sql) and sends the
// reminders people set from an AI app (the connector's set_reminder tool).
// Reminders set in the app itself are scheduled on the phone instead
// (lib/eventReminders.ts) and never have reminder_push set, so nothing here
// doubles them.

// Same wording as lib/eventReminders.ts labelFor.
const labelFor = (minutesBefore: number) =>
  minutesBefore >= 1440
    ? `${Math.round(minutesBefore / 1440)} day${minutesBefore >= 2880 ? 's' : ''}`
    : minutesBefore >= 60
    ? `${Math.round(minutesBefore / 60)} hour${minutesBefore >= 120 ? 's' : ''}`
    : `${minutesBefore} minutes`;

// The longest reminder the connector offers is 1 day.
const MAX_LEAD_MINUTES = 1440;

serve(async (req) => {
  const denied = await rejectUnlessCron(req);
  if (denied) return denied;
  try {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const now = new Date();
    const horizon = new Date(now.getTime() + (MAX_LEAD_MINUTES + 1) * 60000);

    const { data: rows, error } = await admin
      .from('invitees')
      .select('id, user_id, reminder_minutes_before, reminder_pushed_for, events!inner(id, title, event_date, status)')
      .eq('reminder_push', true)
      .not('reminder_minutes_before', 'is', null)
      .not('user_id', 'is', null)
      .gt('events.event_date', now.toISOString())
      .lte('events.event_date', horizon.toISOString())
      .limit(2000);
    if (error) throw new Error(`fetch reminders: ${error.message}`);

    let sent = 0;
    // deno-lint-ignore no-explicit-any
    for (const r of (rows || []) as any[]) {
      const e = r.events;
      if (!e || e.status !== 'sent') continue;
      const start = new Date(e.event_date);
      const fireAt = start.getTime() - r.reminder_minutes_before * 60000;
      if (fireAt > now.getTime()) continue;
      if (r.reminder_pushed_for && new Date(r.reminder_pushed_for).getTime() === start.getTime()) continue;

      // Claim it first, so two overlapping runs can't both send it.
      const { data: claimed } = await admin
        .from('invitees')
        .update({ reminder_pushed_for: e.event_date })
        .eq('id', r.id)
        .eq('reminder_push', true)
        .or(`reminder_pushed_for.is.null,reminder_pushed_for.neq.${e.event_date}`)
        .select('id');
      if (!claimed || claimed.length === 0) continue;

      const title = e.title;
      const body = `Starting in ${labelFor(r.reminder_minutes_before)}`;
      const { error: notifError } = await admin
        .from('notifications')
        .insert([{ recipient_id: r.user_id, type: 'event_reminder', event_id: e.id, title, body }]);
      if (notifError) console.error('Error saving reminder notification:', notifError);

      await admin.functions
        .invoke('send-push', {
          body: { user_ids: [r.user_id], title, body, data: { eventId: e.id, type: 'event_reminder' } },
        })
        .catch((err) => console.error('Push notification failed:', err));
      sent++;
    }

    return new Response(JSON.stringify({ sent }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
