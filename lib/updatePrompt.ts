import { Alert, AppState, Linking, Platform } from 'react-native';
import Constants from 'expo-constants';
import AsyncStorage from '@react-native-async-storage/async-storage';

// "A new version of Ping is available" - asked for in TestFlight feedback
// (build 106) after seeing the same prompt in another app.
//
// Apple's public lookup endpoint returns whatever version the App Store is
// currently serving, so this needs no backend of its own: compare it to the
// version this build was made from and offer the update when the store is
// ahead. TestFlight builds are usually ahead of the store, so they're never
// prompted. iOS only - there's no Play Store listing yet.

const APP_STORE_ID = '6799301780';
const LOOKUP_URL = `https://itunes.apple.com/lookup?id=${APP_STORE_ID}`;
const STORE_URL = `itms-apps://apps.apple.com/app/id${APP_STORE_ID}`;

// After "Not now", leave that version alone for a few days rather than
// asking on every launch.
const SNOOZE_MS = 3 * 24 * 60 * 60 * 1000;
// A resumed app checks again at most this often.
const RECHECK_MS = 12 * 60 * 60 * 1000;

const SNOOZE_KEY = 'updatePrompt.snoozed'; // JSON { version, until }

let lastCheckedAt = 0;
let promptOpen = false;

// "1.10.0" > "1.9.2" - numeric per segment, missing segments count as 0.
export function isNewerVersion(candidate: string, current: string) {
  const a = candidate.split('.').map((n) => parseInt(n, 10) || 0);
  const b = current.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

async function readSnooze(): Promise<{ version: string; until: number } | null> {
  try {
    const raw = await AsyncStorage.getItem(SNOOZE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function snooze(version: string) {
  try {
    await AsyncStorage.setItem(SNOOZE_KEY, JSON.stringify({ version, until: Date.now() + SNOOZE_MS }));
  } catch {
    // Worst case it asks again next launch.
  }
}

export async function checkForAppUpdate() {
  if (Platform.OS !== 'ios' || promptOpen) return;
  const installed = Constants.expoConfig?.version;
  if (!installed) return;
  lastCheckedAt = Date.now();

  let storeVersion: string | undefined;
  try {
    // A cache-buster, since Apple's CDN can hold an old answer for a while
    // after a release goes live.
    const res = await fetch(`${LOOKUP_URL}&t=${Date.now()}`);
    const json = await res.json();
    storeVersion = json?.results?.[0]?.version;
  } catch {
    return; // Offline or Apple's endpoint hiccuped - try again next time.
  }
  if (!storeVersion || !isNewerVersion(storeVersion, installed)) return;

  const snoozed = await readSnooze();
  if (snoozed && snoozed.version === storeVersion && snoozed.until > Date.now()) return;

  promptOpen = true;
  Alert.alert(
    'New version of Ping',
    `Version ${storeVersion} is available on the App Store with the latest fixes and features.`,
    [
      {
        text: 'Not now',
        style: 'cancel',
        onPress: () => {
          promptOpen = false;
          snooze(storeVersion);
        },
      },
      {
        text: 'Update',
        onPress: () => {
          promptOpen = false;
          Linking.openURL(STORE_URL).catch(() =>
            Linking.openURL(`https://apps.apple.com/app/id${APP_STORE_ID}`).catch(() => {})
          );
        },
      },
    ],
    { cancelable: false }
  );
}

// Checks now, then again whenever the app comes back to the foreground if
// it's been a while - people leave Ping open in the background for days.
// Returns a cleanup function.
export function watchForAppUpdates() {
  checkForAppUpdate();
  const sub = AppState.addEventListener('change', (state) => {
    if (state === 'active' && Date.now() - lastCheckedAt > RECHECK_MS) checkForAppUpdate();
  });
  return () => sub.remove();
}
