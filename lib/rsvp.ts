import { Alert } from 'react-native';
import { supabase } from '../supabase';
import { notify } from './notify';

export type RsvpStatus = 'pending' | 'accepted' | 'declined' | 'interested';

type SubmitRsvpOptions = {
  eventId: string;
  // Every host - primary and co-hosts - who should hear about this RSVP.
  hostIds: string[];
  eventTitle: string;
  userId: string;
  myInviteeId: string | null;
  responderName: string;
  status: 'accepted' | 'declined' | 'interested';
  // Only meaningful when myInviteeId is null (a fresh invitee row gets
  // created) - 'discover' marks a Discover self-join so it can later be
  // told apart from a real host invite (see EventDetailContent's
  // handleDiscoverLeave, which self-deletes only invited_via='discover'
  // rows). Defaults to 'app', matching every existing caller.
  invitedVia?: 'app' | 'discover';
};

// Shared by EventDetailContent's RSVP row and InvitePopup so both surfaces
// mutate `invitees` the same way and never drift out of sync.
export type SubmitRsvpResult = { inviteeId: string | null; error: boolean };

export async function submitRsvp(opts: SubmitRsvpOptions): Promise<SubmitRsvpResult> {
  const { eventId, hostIds, eventTitle, userId, myInviteeId, responderName, status, invitedVia = 'app' } = opts;

  let inviteeId = myInviteeId;
  let hadError = false;

  if (myInviteeId) {
    const { error } = await supabase
      .from('invitees')
      .update({ rsvp_status: status, responded_at: new Date().toISOString() })
      .eq('id', myInviteeId);
    if (error) {
      console.error('Error updating RSVP:', error);
      hadError = true;
    }
  } else {
    const { data, error } = await supabase
      .from('invitees')
      .insert([
        {
          event_id: eventId,
          user_id: userId,
          rsvp_status: status,
          invited_via: invitedVia,
          responded_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();
    if (error) {
      console.error('Error creating RSVP:', error);
      hadError = true;
    }
    inviteeId = data?.id || null;
  }

  if (hadError) return { inviteeId, error: true };

  if (status === 'declined' && inviteeId) {
    const { error: releaseError } = await supabase.from('item_claims').delete().eq('invitee_id', inviteeId);
    if (releaseError) console.error('Error releasing claims:', releaseError);
  }

  const recipientHostIds = hostIds.filter((id) => id !== userId);
  if (recipientHostIds.length > 0) {
    const statusLabel = status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : 'is interested in';
    await notify(recipientHostIds, 'RSVP update', `${responderName} ${statusLabel} ${eventTitle}`, {
      eventId,
      type: 'rsvp_update',
    });
  }

  return { inviteeId, error: false };
}

// A repeating Ping is stored as one event row per date, sharing a
// recurrence_id, with its own invitee row per date. These let someone answer
// once for every date from this one on, instead of date by date - and send the
// hosts a single notification instead of one per date.
export type SeriesInvite = {
  inviteeId: string;
  event: { id: string; title: string; event_date: string; end_date: string | null; is_all_day: boolean; location: string };
};

export async function findMySeriesInvites(
  recurrenceId: string,
  fromEventDate: string,
  userId: string
): Promise<SeriesInvite[]> {
  const { data, error } = await supabase
    .from('invitees')
    .select('id, events!inner(id, title, event_date, end_date, is_all_day, location, recurrence_id)')
    .eq('user_id', userId)
    .eq('events.recurrence_id', recurrenceId)
    .gte('events.event_date', fromEventDate);
  if (error) {
    console.error('Error loading series invites:', error);
    return [];
  }
  return (data || []).map((row: any) => ({ inviteeId: row.id, event: row.events }));
}

type SubmitSeriesRsvpOptions = {
  invites: SeriesInvite[];
  hostIds: string[];
  eventTitle: string;
  userId: string;
  responderName: string;
  status: 'accepted' | 'declined' | 'interested';
};

// Returns the invites that were actually updated. A capacity-limited date that
// has filled up rejects 'accepted' (see discover_capacity.sql), so dates are
// retried one by one if the batch update fails, skipping only the full ones.
export async function submitSeriesRsvp(opts: SubmitSeriesRsvpOptions): Promise<SeriesInvite[]> {
  const { invites, hostIds, eventTitle, userId, responderName, status } = opts;
  if (invites.length === 0) return [];
  const patch = { rsvp_status: status, responded_at: new Date().toISOString() };

  let updated = invites;
  const { error } = await supabase
    .from('invitees')
    .update(patch)
    .in('id', invites.map((i) => i.inviteeId));
  if (error) {
    updated = [];
    for (const invite of invites) {
      const { error: oneError } = await supabase.from('invitees').update(patch).eq('id', invite.inviteeId);
      if (oneError) console.error('Error updating series RSVP date:', invite.event.event_date, oneError);
      else updated.push(invite);
    }
  }
  if (updated.length === 0) return [];

  if (status === 'declined') {
    const { error: releaseError } = await supabase
      .from('item_claims')
      .delete()
      .in('invitee_id', updated.map((i) => i.inviteeId));
    if (releaseError) console.error('Error releasing claims:', releaseError);
  }

  const recipientHostIds = hostIds.filter((id) => id !== userId);
  if (recipientHostIds.length > 0) {
    const statusLabel = status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : 'is interested in';
    const scope = updated.length > 1 ? ` (all ${updated.length} upcoming dates)` : '';
    await notify(recipientHostIds, 'RSVP update', `${responderName} ${statusLabel} ${eventTitle}${scope}`, {
      eventId: updated[0].event.id,
      type: 'rsvp_update',
    });
  }
  return updated;
}

// Asks whether a response to one date of a repeating Ping should cover just
// that date or every upcoming one. Resolves null if cancelled.
export function askRsvpScope(upcomingCount: number): Promise<'one' | 'all' | null> {
  return new Promise((resolve) => {
    Alert.alert('This Ping repeats', 'Respond to just this date, or every upcoming one?', [
      { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) },
      { text: 'This date only', onPress: () => resolve('one') },
      { text: `All ${upcomingCount} upcoming dates`, onPress: () => resolve('all') },
    ], { cancelable: true, onDismiss: () => resolve(null) });
  });
}
