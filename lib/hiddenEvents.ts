import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'ping.hiddenExternalEventIds';

// Hiding a phone-calendar event from Upcoming (e.g. a shared family
// calendar's entries that don't pertain to this user) is purely a local
// display preference - nothing about the event itself changes, and it
// doesn't need to sync to Supabase or across devices, so plain on-device
// storage is enough.
export async function getHiddenEventIds(): Promise<Set<string>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch (err) {
    console.error('Error reading hidden events:', err);
    return new Set();
  }
}

async function saveHiddenEventIds(ids: Set<string>): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch (err) {
    console.error('Error saving hidden events:', err);
  }
}

export async function hideEvent(eventId: string): Promise<Set<string>> {
  const ids = await getHiddenEventIds();
  ids.add(eventId);
  await saveHiddenEventIds(ids);
  return ids;
}

export async function unhideEvent(eventId: string): Promise<Set<string>> {
  const ids = await getHiddenEventIds();
  ids.delete(eventId);
  await saveHiddenEventIds(ids);
  return ids;
}

// A recurring calendar event's occurrences aren't guaranteed to be unique
// by e.id alone across every calendar/OS combination expo-calendar runs
// on - hiding by a bare id risked either silently hiding every occurrence
// of the series (if the id turns out to be shared) or the hide quietly
// not sticking on the next fetch (if it isn't). Folding the occurrence's
// own start time into the key sidesteps both failure modes without
// needing to know which one applies on a given device - this is what was
// behind a converted (Ping'd) calendar item's original occurrence
// reappearing on the calendar after the fact (real reported bug).
export function hiddenKeyFor(event: { id: string; recurrenceRule?: unknown; startDate: Date }): string {
  return event.recurrenceRule ? `${event.id}::${event.startDate.toISOString()}` : event.id;
}

// True if this exact occurrence was hidden (hiddenKeyFor's per-occurrence
// key) OR the whole series was ("hide this and following events" - stored
// as the bare, occurrence-less id, since there's no single instanceStartDate
// that covers every future occurrence). For a non-recurring event the two
// checks are the same key, so this is just a plain membership test there.
export function isHidden(event: { id: string; recurrenceRule?: unknown; startDate: Date }, hiddenIds: Set<string>): boolean {
  return hiddenIds.has(hiddenKeyFor(event)) || hiddenIds.has(event.id);
}
