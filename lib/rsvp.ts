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
export async function submitRsvp(opts: SubmitRsvpOptions): Promise<string | null> {
  const { eventId, hostIds, eventTitle, userId, myInviteeId, responderName, status, invitedVia = 'app' } = opts;

  let inviteeId = myInviteeId;

  if (myInviteeId) {
    const { error } = await supabase
      .from('invitees')
      .update({ rsvp_status: status, responded_at: new Date().toISOString() })
      .eq('id', myInviteeId);
    if (error) console.error('Error updating RSVP:', error);
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
    if (error) console.error('Error creating RSVP:', error);
    inviteeId = data?.id || null;
  }

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

  return inviteeId;
}
