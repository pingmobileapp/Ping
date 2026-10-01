import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// A contact's link to a real Ping account is only ever checked once, right
// when an invite is created (see findOrCreateContact/healContactLink in
// lib/phone.ts) - if someone was invited before they'd created an account
// (or before they'd set the right phone number in Settings), that invite's
// invitees.user_id stayed null forever, since nothing ever re-checked it
// later. That made the event invisible on that person's Home screen (its
// own query filters on invitees.user_id = auth.uid()) and meant they never
// got notified - permanently, with no way to discover it short of the host
// noticing and manually removing/re-inviting them. Real support case,
// 2026-09-10: two family members (one brand new, one who'd had an account
// for a while) were both stuck this way; a one-time backfill found 16
// stranded invites across the whole family, not just those two.
//
// This closes the gap going forward: called right after Settings saves a
// phone number, using the now-current phone to find and heal any contact
// records (system-wide, not just the caller's own) that reference it, then
// cascades that into any invitees rows still waiting on that link, and
// notifies the caller about each event that just became visible to them.
// Runs as an edge function rather than a plain client update specifically
// because it has to touch OTHER people's contacts rows (whoever has this
// person's phone number saved) - a regular RLS-scoped client call can't do
// that, only this account's own data.
serve(async (req) => {
  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 });
    }

    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const {
      data: { user },
      error: userError,
    } = await callerClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401 });
    }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('phone')
      .eq('id', user.id)
      .maybeSingle();
    if (profileError) throw new Error(`look up profile: ${profileError.message}`);
    if (!profile?.phone) {
      return new Response(JSON.stringify({ healedInvites: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const { error: contactsError } = await admin
      .from('contacts')
      .update({ linked_user_id: user.id })
      .eq('phone', profile.phone)
      .is('linked_user_id', null);
    if (contactsError) throw new Error(`heal contacts: ${contactsError.message}`);

    // Every contact with this number that now points at this account - not
    // just the ones linked a moment ago. A contact can already have been
    // linked by a later invite (lib/phone.ts heals it at invite time), which
    // fixes that new invite but leaves any earlier one still waiting.
    const { data: linkedContacts, error: linkedError } = await admin
      .from('contacts')
      .select('id')
      .eq('phone', profile.phone)
      .eq('linked_user_id', user.id);
    if (linkedError) throw new Error(`look up linked contacts: ${linkedError.message}`);

    const contactIds = (linkedContacts || []).map((c) => c.id);
    if (contactIds.length === 0) {
      return new Response(JSON.stringify({ healedInvites: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const { data: waiting, error: waitingError } = await admin
      .from('invitees')
      .select('id, event_id')
      .in('contact_id', contactIds)
      .is('user_id', null);
    if (waitingError) throw new Error(`look up waiting invites: ${waitingError.message}`);

    // invitees has UNIQUE (event_id, user_id), and one bulk update that would
    // break it fails as a whole - linking none of this person's invites. A
    // waiting row is redundant when they're already on that event (the host
    // re-added them another way) or a second waiting row for the same event
    // (two saved contacts with this number), so those are dropped and only
    // one row per event is linked.
    const waitingEventIds = Array.from(new Set((waiting || []).map((w) => w.event_id)));
    const { data: existing, error: existingError } = waitingEventIds.length
      ? await admin.from('invitees').select('event_id').eq('user_id', user.id).in('event_id', waitingEventIds)
      : { data: [], error: null };
    if (existingError) throw new Error(`look up existing invites: ${existingError.message}`);
    const coveredEvents = new Set((existing || []).map((e) => e.event_id));
    const toLink: string[] = [];
    const redundant: string[] = [];
    for (const w of waiting || []) {
      if (coveredEvents.has(w.event_id)) redundant.push(w.id);
      else {
        coveredEvents.add(w.event_id);
        toLink.push(w.id);
      }
    }

    if (redundant.length > 0) {
      const { error: deleteError } = await admin.from('invitees').delete().in('id', redundant);
      if (deleteError) throw new Error(`drop redundant invites: ${deleteError.message}`);
    }

    const { data: healedInvitees, error: inviteesError } = toLink.length
      ? await admin.from('invitees').update({ user_id: user.id }).in('id', toLink).select('event_id, events(title)')
      : { data: [], error: null };
    if (inviteesError) throw new Error(`heal invitees: ${inviteesError.message}`);

    const rows = healedInvitees || [];

    // Same consolidated-notification shape as notify() in lib/notify.ts -
    // one row per event thread, bumped to unread.
    for (const row of rows) {
      const title = (row.events as { title?: string } | null)?.title || 'an event';
      const { error: notifyError } = await admin.from('notifications').upsert(
        {
          recipient_id: user.id,
          notif_group: 'event_activity',
          type: 'invite',
          event_id: row.event_id,
          thread_key: row.event_id,
          title: "You're invited! 🎉",
          body: `${title} — tap to view and RSVP`,
          created_at: new Date().toISOString(),
          read_at: null,
        },
        { onConflict: 'recipient_id,notif_group,thread_key' }
      );
      if (notifyError) console.error('Error upserting healed-invite notification:', notifyError);
    }

    if (rows.length > 0) {
      const lastTitle = (rows[rows.length - 1].events as { title?: string } | null)?.title || 'an event';
      const pushBody =
        rows.length === 1
          ? `${lastTitle} — tap to view and RSVP`
          : `${rows.length} events are waiting for your RSVP, including ${lastTitle}`;
      await admin.functions
        .invoke('send-push', {
          body: {
            user_ids: [user.id],
            title: "You're invited! 🎉",
            body: pushBody,
            data: { eventId: rows[0].event_id, type: 'invite' },
          },
        })
        .catch((err) => console.error('Push notification failed:', err));
    }

    return new Response(JSON.stringify({ healedInvites: rows.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
