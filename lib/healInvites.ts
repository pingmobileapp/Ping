import { supabase } from '../supabase';

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
    return (data as { healedInvites?: number } | null)?.healedInvites ?? 0;
  } catch (err) {
    console.error('Error linking pending invites:', err);
    return 0;
  }
}
