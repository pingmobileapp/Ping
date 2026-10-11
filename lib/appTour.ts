import AsyncStorage from '@react-native-async-storage/async-storage';

// Who sees the Home tour (components/AppTour.tsx):
// - New accounts, automatically, once. "New" means created within the last
//   few days, so people who already use Ping don't get a surprise tour the
//   day this ships.
// - Anyone who taps "Take the app tour" in Settings, any time.
// Finishing or skipping both count as done. Saved per account on this
// device - a brand-new user on a second phone would see it once more,
// which is fine.

const NEW_ACCOUNT_DAYS = 3;
const doneKey = (userId: string) => `appTour.done.${userId}`;
const replayKey = (userId: string) => `appTour.replay.${userId}`;

export async function shouldShowAppTour(userId: string, accountCreatedAt?: string | null): Promise<boolean> {
  try {
    if (await AsyncStorage.getItem(replayKey(userId))) return true;
    if (await AsyncStorage.getItem(doneKey(userId))) return false;
  } catch {
    return false; // If storage is unreadable, never risk showing it every launch.
  }
  if (!accountCreatedAt) return false;
  const ageMs = Date.now() - new Date(accountCreatedAt).getTime();
  return ageMs >= 0 && ageMs < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
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
