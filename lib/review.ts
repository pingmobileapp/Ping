import AsyncStorage from '@react-native-async-storage/async-storage';

// Asks for an App Store / Google Play rating after something good happens.
// Never on the first good moment: only the 3rd, and then not again for 4 months.
// Apple also caps the prompt at 3 times a year and may skip showing it.
const COUNT_KEY = 'review.goodMoments';
const ASKED_KEY = 'review.lastAsked';
const NEEDED = 3;
const WAIT_MS = 120 * 24 * 60 * 60 * 1000;

// Loaded lazily: an over-the-air update can reach an older build that doesn't have
// the native rating module yet, and then this quietly does nothing instead of crashing.
function storeReview(): typeof import('expo-store-review') | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-store-review');
  } catch {
    return null;
  }
}

/** Call right after a happy moment. Waits `delayMs` so it doesn't cover what's on screen. Never throws. */
export async function goodMoment(delayMs = 1500) {
  try {
    const count = Number((await AsyncStorage.getItem(COUNT_KEY)) ?? 0) + 1;
    await AsyncStorage.setItem(COUNT_KEY, String(count));
    if (count < NEEDED) return;
    const last = Number((await AsyncStorage.getItem(ASKED_KEY)) ?? 0);
    if (Date.now() - last < WAIT_MS) return;
    const StoreReview = storeReview();
    if (!StoreReview || !(await StoreReview.isAvailableAsync())) return;
    await AsyncStorage.multiSet([
      [ASKED_KEY, String(Date.now())],
      [COUNT_KEY, '0'],
    ]);
    setTimeout(() => {
      StoreReview.requestReview().catch(() => {});
    }, delayMs);
  } catch {
    // A rating prompt is never worth an error.
  }
}
