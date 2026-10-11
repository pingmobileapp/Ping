import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';

// Who sees the Home tour (components/AppTour.tsx):
// - New accounts, automatically, once. "New" means created within the last
//   few days.
// - Existing accounts that have barely used Ping (hosted fewer than 2 Pings
//   and answered fewer than 3 invites) are offered it once - same tour,
//   but the first bubble asks "Want a quick tour?" with a No thanks.
//   Regular users never get a surprise tour.
// - Anyone who taps "Take the app tour" in Settings, any time.
// Finishing or skipping both count as done. Saved per account on this
// device - a brand-new user on a second phone would see it once more,
// which is fine.

const NEW_ACCOUNT_DAYS = 3;
const doneKey = (userId: string) => `appTour.done.${userId}`;
const replayKey = (userId: string) => `appTour.replay.${userId}`;

// 'new' = straight into the tour, 'offer' = ask first, null = don't show.
export type AppTourMode = 'new' | 'offer' | null;

async function isLightUser(userId: string): Promise<boolean> {
  const [hosted, answered] = await Promise.all([
    supabase.from('events').select('id', { count: 'exact', head: true }).eq('host_id', userId),
    supabase
      .from('invitees')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', userId)
      .neq('rsvp_status', 'pending'),
  ]);
  // Can't tell (offline, error) - don't bother them.
  if (hosted.error || answered.error || hosted.count == null || answered.count == null) return false;
  return hosted.count < 2 && answered.count < 3;
}

export async function getAppTourMode(userId: string, accountCreatedAt?: string | null): Promise<AppTourMode> {
  try {
    if (await AsyncStorage.getItem(replayKey(userId))) return 'new';
    if (await AsyncStorage.getItem(doneKey(userId))) return null;
  } catch {
    return null; // If storage is unreadable, never risk showing it every launch.
  }
  if (!accountCreatedAt) return null;
  const ageMs = Date.now() - new Date(accountCreatedAt).getTime();
  if (ageMs >= 0 && ageMs < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000) return 'new';
  return (await isLightUser(userId)) ? 'offer' : null;
}

export async function markAppTourDone(userId: string) {
  try {
    await AsyncStorage.multiSet([[doneKey(userId), new Date().toISOString()]]);
    await AsyncStorage.removeItem(replayKey(userId));
  } catch {
    // Worst case it shows again next launch.
  }
}

// From Settings: Home picks this up the next time it's focused.
export async function requestAppTourReplay(userId: string) {
  try {
    await AsyncStorage.setItem(replayKey(userId), '1');
  } catch {
    // Nothing useful to do - the button just won't take effect.
  }
}
