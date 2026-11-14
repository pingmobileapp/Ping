import { DeviceEventEmitter } from 'react-native';
import { supabase } from '../supabase';

// Fired whenever a heal links at least one invite. Callers don't await
// healInviteLinks (Settings fires it and goes back; the root layout runs it
// while Home is already loading), so Home's own fetch could land first and
// miss the newly linked event - it then showed only as a "You're invited"
// notification, not on the calendar (Android friend, 2026-11-14, who'd
// accepted on the web invite page before signing up). Home listens for this
// and refetches.
export const INVITES_LINKED_EVENT = 'ping:invites-linked';

export function onInvitesLinked(listener: () => void): () => void {
  const sub = DeviceEventEmitter.addListener(INVITES_LINKED_EVENT, listener);
  return () => sub.remove();
}

// Links any invites that were sent to this account's phone number before
// the account existed (or before the number was saved in Settings) - see
// supabase/functions/heal-invitee-links for the full story. Until this was
// wired up, nothing in the app ever called that function, so someone
// invited before joining never saw the invite until the host removed and
// re-added them (real report, 2026-10-01). Safe to call any time: it's a
// no-op when there's no phone on file or nothing is waiting, and it sends
// its own "You're invited" notification for each invite it links.
export async function healInviteLinks(): Promise<number> {
  try {
    const { data, error } = await supabase.functions.invoke('heal-invitee-links');
    if (error) throw error;
    const healed = (data as { healedInvites?: number } | null)?.healedInvites ?? 0;
    if (healed > 0) DeviceEventEmitter.emit(INVITES_LINKED_EVENT, healed);
    return healed;
  } catch (err) {
    console.error('Error linking pending invites:', err);
    return 0;
  }
}
