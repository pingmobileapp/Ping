import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// None of these tables declare a foreign key back to auth.users (or, for
// several, even to profiles) - profiles.id is just a plain uuid kept in
// sync by convention, so deleting the auth user alone leaves every row
// below behind. This walks the ownership graph by hand instead, in FK-safe
// order (dependents before the rows they reference), then removes the
// profile and finally the auth user itself.
//
// Every step is labeled and its error checked explicitly (supabase-js
// never throws on a failed mutation, it just returns {error}) - silently
// pressing on past a failed step here would mean reporting success to the
// user while some of their data, or the auth user itself, is still there.
serve(async (req) => {
  const step = async (label: string, promise: PromiseLike<{ error: { message: string } | null }>) => {
    const { error } = await promise;
    if (error) throw new Error(`${label}: ${error.message}`);
  };

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization' }), { status: 401 });
    }

    // Resolves the caller's own id from their JWT - never trust a user id
    // passed in the request body, or any signed-in caller could delete
    // anyone else's account.
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
    const uid = user.id;

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    // Events this user hosts - deleted explicitly by id below, once every
    // invitee on them has had its item_claims/items.assigned_to cleared.
    // Cascading events -> invitees -> item_claims can't be left to Postgres
    // alone: item_claims.invitee_id and items.assigned_to are both NO
    // ACTION (not cascade), so an event with a claimed item fails the
    // whole delete the moment the cascade reaches that invitee row.
    const { data: hostedEvents, error: hostedEventsError } = await admin
      .from('events')
      .select('id')
      .or(`host_id.eq.${uid},created_by.eq.${uid}`);
    if (hostedEventsError) throw new Error(`look up hosted events: ${hostedEventsError.message}`);
    const hostedEventIds = (hostedEvents || []).map((r: { id: string }) => r.id);

    // Every invitee row about to be affected: everyone invited to events
    // this user hosts (those events are going away entirely), plus this
    // user's own invitee rows on events someone else hosts.
    const affectedInviteeIds: string[] = [];
    if (hostedEventIds.length > 0) {
      const { data: hostedInvitees, error: hostedInviteesError } = await admin
        .from('invitees')
        .select('id')
        .in('event_id', hostedEventIds);
      if (hostedInviteesError) throw new Error(`look up invitees on hosted events: ${hostedInviteesError.message}`);
      affectedInviteeIds.push(...(hostedInvitees || []).map((r: { id: string }) => r.id));
    }
    const { data: ownInvitees, error: ownInviteesError } = await admin.from('invitees').select('id').eq('user_id', uid);
    if (ownInviteesError) throw new Error(`look up own invitee rows: ${ownInviteesError.message}`);
    const ownInviteeIds = (ownInvitees || []).map((r: { id: string }) => r.id);
    affectedInviteeIds.push(...ownInviteeIds);

    if (affectedInviteeIds.length > 0) {
      await step('delete item claims', admin.from('item_claims').delete().in('invitee_id', affectedInviteeIds));
      await step('unassign items', admin.from('items').update({ assigned_to: null }).in('assigned_to', affectedInviteeIds));
    }
    // Own invitee rows on events someone else hosts - invitees on this
    // user's own hosted events (the other half of affectedInviteeIds) are
    // handled by the events delete below via its own cascade, now that
    // item_claims/items.assigned_to are cleared for them too.
    if (ownInviteeIds.length > 0) {
      await step('delete own invitee rows', admin.from('invitees').delete().in('id', ownInviteeIds));
    }
    if (hostedEventIds.length > 0) {
      await step('delete hosted events', admin.from('events').delete().in('id', hostedEventIds));
    }

    // Reactions and messages this user sent on things they don't own -
    // messages on their own hosted events are already gone above.
    await step('delete message reactions', admin.from('message_reactions').delete().eq('user_id', uid));
    await step('delete messages', admin.from('messages').delete().eq('sender_id', uid));

    // Groups this user owns - cascades group_members, group_messages, and
    // the reactions/notifications tied to those.
    await step('delete owned groups', admin.from('groups').delete().eq('owner_id', uid));
    // Messages sent in groups they don't own.
    await step('delete group messages', admin.from('group_messages').delete().eq('sender_id', uid));
    // group_members.user_id is ON DELETE SET NULL, so membership in other
    // people's groups clears itself once the profile row goes below.

    // This user's own contact list - cascades group_members rows keyed to
    // those contacts.
    await step('delete owned contacts', admin.from('contacts').delete().eq('owner_id', uid));
    // Other people's contact entries linked to this account (matched by
    // phone) shouldn't keep pointing at a deleted user.
    await step('unlink contacts', admin.from('contacts').update({ linked_user_id: null }).eq('linked_user_id', uid));

    // Storage cleanup while we still know which files were theirs. Not
    // fatal if it fails - orphaned files aren't a correctness problem the
    // way a leftover database row or a stuck account is.
    try {
      const { data: avatarFiles } = await admin.storage.from('event-images').list(`avatars/${uid}`);
      if (avatarFiles && avatarFiles.length > 0) {
        await admin.storage.from('event-images').remove(avatarFiles.map((f) => `avatars/${uid}/${f.name}`));
      }
      const { data: eventImageFiles } = await admin.storage.from('event-images').list(uid);
      if (eventImageFiles && eventImageFiles.length > 0) {
        await admin.storage.from('event-images').remove(eventImageFiles.map((f) => `${uid}/${f.name}`));
      }
    } catch (err) {
      console.error('Error cleaning up storage for deleted account:', err);
    }

    await step('delete profile', admin.from('profiles').delete().eq('id', uid));

    const { error: deleteAuthError } = await admin.auth.admin.deleteUser(uid);
    if (deleteAuthError) throw new Error(`delete auth user: ${deleteAuthError.message}`);

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }), { status: 500 });
  }
});
