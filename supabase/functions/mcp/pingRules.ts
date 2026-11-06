// The app's own rules, for the AI connector (supabase/functions/mcp).
//
// The app's versions live in lib/ and can't be imported here: they pull in
// react-native (Alert) and the app's own supabase client. These are the same
// rules, taking the per-request supabase client instead. When one of the
// sources below changes, change its copy here too:
//   normalizePhone, healContactLink, dropAccountsAlreadyInvited,
//     getAlreadyInvitedPhones                      <- lib/phone.ts
//   loadMemberGroups                               <- lib/sharedGroups.ts
//   withMentionLabels, findMentionedUserIds,
//     routeMessageAlerts                           <- lib/mentions.ts
//   notify (+ consolidateNotification)             <- lib/notify.ts
//   displayName                                    <- lib/displayName.ts
//   instantFromWallClock, wallClockIn              <- lib/timeZones.ts
//   activityKey, dedupeActivities, region filter   <- lib/discoverActivities.ts,
//                                                     lib/discoverRegion.ts
//   containsObjectionableContent, reportContent    <- lib/contentFilter.ts, lib/moderation.ts
// deleteEvent's cleanup order mirrors lib/deleteEvent.ts and the RSVP writes
// mirror lib/rsvp.ts; those live in tools.ts next to the tool that uses them.

// deno-lint-ignore no-explicit-any
export type Db = any;

// ---------- lib/phone.ts ----------

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits;
}

type MinimalContact = { id: string; name: string; phone: string | null; linked_user_id: string | null };

export async function healContactLink<T extends MinimalContact>(db: Db, contact: T): Promise<T> {
  if (contact.linked_user_id || !contact.phone) return contact;
  const { data: profileMatch } = await db.from('profiles').select('id').eq('phone', contact.phone).maybeSingle();
  if (!profileMatch?.id) return contact;
  const { error } = await db.from('contacts').update({ linked_user_id: profileMatch.id }).eq('id', contact.id);
  return error ? contact : { ...contact, linked_user_id: profileMatch.id };
}

export async function getAlreadyInvitedPhones(db: Db, eventId: string): Promise<Set<string>> {
  const { data } = await db.from('invitees').select('contacts(phone), profiles(phone)').eq('event_id', eventId);
  const phones = new Set<string>();
  // deno-lint-ignore no-explicit-any
  (data || []).forEach((row: any) => {
    const p = normalizePhone(row.contacts?.phone) || normalizePhone(row.profiles?.phone);
    if (p) phones.add(p);
  });
  return phones;
}

export async function dropAccountsAlreadyInvited<T extends { user_id: string | null }>(
  db: Db,
  eventId: string,
  rows: T[]
): Promise<T[]> {
  const { data } = await db.from('invitees').select('user_id').eq('event_id', eventId);
  // deno-lint-ignore no-explicit-any
  const onEvent = new Set((data || []).map((r: any) => r.user_id).filter(Boolean));
  return rows.filter((r) => {
    if (!r.user_id) return true;
    if (onEvent.has(r.user_id)) return false;
    onEvent.add(r.user_id);
    return true;
  });
}

// ---------- lib/sharedGroups.ts ----------

export type GroupMember = { contactId: string; name: string };
export type SelectableGroup = { id: string; name: string; members: GroupMember[]; shared?: boolean };

// Groups shared with you: each member becomes one of your own contacts
// (matched by account or phone, so it's idempotent). Only called when
// inviting, never for a plain read - reading shouldn't write.
export async function loadMemberGroups<T extends MinimalContact>(
  db: Db,
  userId: string,
  myContacts: T[]
): Promise<{ groups: SelectableGroup[]; newContacts: T[] }> {
  const { data, error } = await db
    .from('groups')
    .select('id, name, owner_id, group_members(user_id, contacts(name, phone))')
    .neq('owner_id', userId)
    .order('name');
  if (error) {
    console.error('Error loading shared groups:', error);
    return { groups: [], newContacts: [] };
  }
  const known = [...myContacts];
  const created: T[] = [];
  const groups: SelectableGroup[] = [];
  for (const g of data || []) {
    const members: GroupMember[] = [];
    for (const gm of g.group_members || []) {
      const name = gm.contacts?.name || 'Someone';
      const phone = normalizePhone(gm.contacts?.phone);
      const linkedUserId = gm.user_id || null;
      let contact = known.find(
        (c) => (linkedUserId && c.linked_user_id === linkedUserId) || (phone && normalizePhone(c.phone) === phone)
      );
      if (!contact) {
        const { data: inserted, error: insertError } = await db
          .from('contacts')
          .insert([{ owner_id: userId, name, phone, linked_user_id: linkedUserId }])
          .select()
          .single();
        if (insertError) {
          console.error('Error materializing shared group member as a contact:', insertError);
          continue;
        }
        contact = inserted as T;
        known.push(contact);
        created.push(contact);
      }
      members.push({ contactId: contact.id, name: contact.name });
    }
    groups.push({ id: g.id, name: g.name, members, shared: true });
  }
  return { groups, newContacts: created };
}

// ---------- lib/mentions.ts ----------

export type MentionGuest = { userId: string; fullName: string; label: string };

export function withMentionLabels(guests: { userId: string; fullName: string }[]): MentionGuest[] {
  const counts = new Map<string, number>();
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  for (const g of guests) counts.set(first(g.fullName).toLowerCase(), (counts.get(first(g.fullName).toLowerCase()) ?? 0) + 1);
  return guests.map((g) => {
    const f = first(g.fullName);
    return { ...g, label: (counts.get(f.toLowerCase()) ?? 0) > 1 ? g.fullName.trim() : f };
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentionPattern = (labels: string[]) => {
  const sorted = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  return sorted.length ? new RegExp(`(^|[^\\w])@(${sorted.map(escapeRe).join('|')})(?![\\w'])`, 'gi') : null;
};

export function findMentionedUserIds(body: string, guests: MentionGuest[]): string[] {
  const pattern = mentionPattern(guests.map((g) => g.label));
  if (!pattern) return [];
  const hit = new Set([...body.matchAll(pattern)].map((m) => m[2].toLowerCase()));
  return guests.filter((g) => hit.has(g.label.toLowerCase())).map((g) => g.userId);
}

export function routeMessageAlerts(
  guests: { user_id: string; muted: boolean | null; rsvp_status: string | null }[],
  mentionedIds: string[]
): { mentioned: string[]; normal: string[]; silent: string[] } {
  const mentioned = new Set(mentionedIds);
  const others = guests.filter((g) => !mentioned.has(g.user_id) && g.rsvp_status !== 'declined');
  return {
    mentioned: guests.filter((g) => mentioned.has(g.user_id)).map((g) => g.user_id),
    normal: others.filter((g) => !g.muted).map((g) => g.user_id),
    silent: others.filter((g) => g.muted).map((g) => g.user_id),
  };
}

// ---------- lib/displayName.ts ----------

function formatEmailLocalPart(localPart: string): string {
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

export function displayName(
  profile: { full_name?: string | null; email?: string | null } | null | undefined,
  fallback = 'Guest'
): string {
  if (!profile) return fallback;
  if (profile.full_name) return profile.full_name;
  if (profile.email) return formatEmailLocalPart(profile.email.split('@')[0]) || fallback;
  return fallback;
}

// ---------- lib/notify.ts ----------

export type NotificationType =
  | 'invite'
  | 'event_canceled'
  | 'event_updated'
  | 'message'
  | 'rsvp_update'
  | 'item_claimed'
  | 'report';

const NOTIF_GROUP: Partial<Record<NotificationType, string>> = {
  invite: 'event_activity',
  event_updated: 'event_activity',
  rsvp_update: 'event_activity',
  item_claimed: 'event_activity',
  message: 'message',
};

export async function notify(
  db: Db,
  pushAuth: { url: string; token: string; apikey: string },
  userIds: (string | null | undefined)[],
  title: string,
  body: string,
  opts: { eventId?: string; type: NotificationType; silent?: boolean }
) {
  const ids = Array.from(new Set(userIds.filter(Boolean))) as string[];
  if (ids.length === 0) return;
  const group = NOTIF_GROUP[opts.type];
  if (group) {
    await Promise.all(
      ids.map(async (id) => {
        const { error } = await db.from('notifications').upsert(
          {
            recipient_id: id,
            notif_group: group,
            type: opts.type,
            event_id: opts.eventId ?? null,
            group_id: null,
            thread_key: opts.eventId ?? null,
            title,
            body,
            created_at: new Date().toISOString(),
            read_at: null,
          },
          { onConflict: 'recipient_id,notif_group,thread_key' }
        );
        if (error) console.error('Error upserting notification:', error);
      })
    );
  } else {
    const { error } = await db.from('notifications').insert(
      ids.map((id) => ({ recipient_id: id, type: opts.type, event_id: opts.eventId ?? null, group_id: null, title, body }))
    );
    if (error) console.error('Error saving notification:', error);
  }
  if (opts.silent) return;

  let hasPrice = false;
  if (opts.type === 'invite' && opts.eventId) {
    const { data: priceRow } = await db.from('events').select('price_cents').eq('id', opts.eventId).maybeSingle();
    hasPrice = !!(priceRow?.price_cents && priceRow.price_cents > 0);
  }
  // Same call the app makes (supabase.functions.invoke('send-push')), as the
  // signed-in person.
  try {
    await fetch(`${pushAuth.url}/functions/v1/send-push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pushAuth.token}`,
        apikey: pushAuth.apikey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        user_ids: ids,
        title,
        body,
        data: { eventId: opts.eventId, type: opts.type, hasPrice },
      }),
    });
  } catch (err) {
    console.error('Push notification failed:', err);
  }
}

// ---------- lib/timeZones.ts ----------

function partsIn(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(instant)
      .map((p) => [p.type, p.value])
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function offsetMs(instantMs: number, timeZone: string): number {
  const p = partsIn(new Date(instantMs), timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// "2026-11-07T18:00" read as a clock time in timeZone -> the real moment.
export function instantFromLocal(local: { y: number; mo: number; d: number; h: number; mi: number }, timeZone: string): Date {
  const target = Date.UTC(local.y, local.mo - 1, local.d, local.h, local.mi, 0);
  let guess = target - offsetMs(target, timeZone);
  guess = target - offsetMs(guess, timeZone);
  return new Date(guess);
}

// The real moment shown as a clock time in timeZone: "Sat, Nov 7, 2026, 6:00 PM MST".
export function formatInZone(iso: string, timeZone: string | null | undefined, allDay = false): string {
  const tz = timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const d = new Date(iso);
  if (allDay) {
    // The app saves an all-day Ping as some moment on that day on the phone
    // (the connector saves noon), and shows the phone's local date.
    return d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }
  return d.toLocaleString('en-US', {
    timeZone: tz,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

// ---------- lib/discoverActivities.ts / lib/discoverRegion.ts ----------

export const activityKey = (a: { title: string; startsAt: string }): string =>
  `${a.title.trim().toLowerCase()}|${a.startsAt}`;

export type Activity = {
  id: string;
  source: string;
  title: string;
  category: string;
  description: string | null;
  location: string | null;
  lat: number | null;
  lng: number | null;
  startsAt: string;
  endsAt: string | null;
  priceLabel: string | null;
  url: string | null;
  timeTba?: boolean;
  pingEventId?: string;
};

const TIME_TOLERANCE_MS = 90 * 60000;
const MIN_TITLE_OVERLAP = 0.12;
const LOCATION_SIMILARITY_THRESHOLD = 0.4;
const STRONG_TITLE_THRESHOLD = 0.6;
const SOURCE_PRIORITY: Record<string, number> = {
  ticketmaster: 3,
  seatgeek: 3,
  ai_search_utahagenda: 2,
  ai_search_collegesports: 2,
  ai_search_prosports: 2,
  ai_search_concerts: 2,
  ai_search_hs6a: 2,
  ai_search: 1,
};
const baseSource = (s: string) => (s.endsWith('_boise') ? s.slice(0, -'_boise'.length) : s);
const wordSet = (s: string) =>
  new Set(s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean));
const jaccard = (a: Set<string>, b: Set<string>) => {
  if (a.size === 0 || b.size === 0) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
};

export function dedupeActivities(activities: Activity[]): Activity[] {
  const sorted = [...activities].sort(
    (a, b) =>
      (SOURCE_PRIORITY[baseSource(b.source)] ?? 0) - (SOURCE_PRIORITY[baseSource(a.source)] ?? 0) ||
      Number(!!a.timeTba) - Number(!!b.timeTba)
  );
  const kept: Activity[] = [];
  for (const c of sorted) {
    const cStart = new Date(c.startsAt).getTime();
    const cLoc = wordSet(c.location ?? '');
    const cTitle = wordSet(c.title);
    const dup = kept.some((e) => {
      if (c.timeTba || e.timeTba) {
        if (new Date(e.startsAt).toDateString() !== new Date(cStart).toDateString()) return false;
      } else if (Math.abs(new Date(e.startsAt).getTime() - cStart) > TIME_TOLERANCE_MS) return false;
      const t = jaccard(cTitle, wordSet(e.title));
      if (t < MIN_TITLE_OVERLAP) return false;
      if (t >= STRONG_TITLE_THRESHOLD) return true;
      const eLoc = wordSet(e.location ?? '');
      if (cLoc.size === 0 || eLoc.size === 0) return false;
      return jaccard(cLoc, eLoc) >= LOCATION_SIMILARITY_THRESHOLD;
    });
    if (!dup) kept.push(c);
  }
  return kept.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
}

export type DiscoverArea = 'utah' | 'boise';
const BOISE = { lat: 43.6121, lng: -116.3915 };
const BOISE_EVENT_RADIUS_MILES = 60;
function miles(aLat: number, aLng: number, bLat: number, bLng: number) {
  const R = 3958.8;
  const r = (x: number) => (x * Math.PI) / 180;
  const dLat = r(bLat - aLat);
  const dLng = r(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(aLat)) * Math.cos(r(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}
export function areaOfActivity(a: { source: string; lat: number | null; lng: number | null }): DiscoverArea | null {
  if (a.source === 'ping') return null;
  if (a.source.endsWith('_boise')) return 'boise';
  if (a.lat !== null && a.lng !== null) {
    return miles(a.lat, a.lng, BOISE.lat, BOISE.lng) <= BOISE_EVENT_RADIUS_MILES ? 'boise' : 'utah';
  }
  return 'utah';
}

// ---------- lib/contentFilter.ts + lib/moderation.ts ----------
// Same as the app: never blocks, just raises the admin report a person's own
// flag would.

// lib/moderation.ts's ADMIN_USER_ID - the admin screen's owner, who hears
// about every new report.
export const ADMIN_USER_ID = '48728f10-a8ac-42b1-8d67-ed57a0b88eca';

// Returns true when a report was filed (the caller then tells the admin).
export async function flagIfObjectionable(
  db: Db,
  text: string,
  report: { userId: string; contentType: 'event' | 'message'; contentId: string; eventId: string }
): Promise<boolean> {
  if (!containsObjectionableContent(text)) return false;
  const { error } = await db.from('reports').insert({
    reporter_id: report.userId,
    reported_user_id: report.userId,
    content_type: report.contentType,
    content_id: report.contentId,
    event_id: report.eventId,
    reason: report.contentType === 'event' ? 'Auto-flagged event content' : 'Auto-flagged message content',
    source: 'auto_filter',
  });
  if (error) {
    console.error('Error filing auto report:', error);
    return false;
  }
  return true;
}

// Copy of lib/contentFilter.ts's list - keep the two the same.
const OBJECTIONABLE_TERMS = [
  'nigger', 'nigga', 'faggot', 'retard', 'cunt', 'kike', 'spic', 'chink', 'tranny', 'rape', 'kill yourself', 'kys',
];
function containsObjectionableContent(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return OBJECTIONABLE_TERMS.some((term) => normalized.includes(term));
}
