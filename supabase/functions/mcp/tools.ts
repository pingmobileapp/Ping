// The AI connector's tools. Every query runs through `ctx.db`, a supabase
// client carrying the signed-in person's own token, so Row Level Security
// decides what they can see and change - exactly as in the app. Nothing here
// uses the service role.
//
// Words shown to people stay the app's: "New Event", "Invite People",
// "What to bring", "Discover". Never "create a Ping".

import { decode as decodeImage, Image } from 'https://deno.land/x/imagescript@1.3.0/mod.ts';
import {
  partsIn,
  containsObjectionableContent,
  activityKey,
  ADMIN_USER_ID,
  areaOfActivity,
  dedupeActivities,
  displayName,
  dropAccountsAlreadyInvited,
  findMentionedUserIds,
  flagIfObjectionable,
  formatInZone,
  getAlreadyInvitedPhones,
  healContactLink,
  instantFromLocal,
  isValidTimeZone,
  loadMemberGroups,
  normalizePhone,
  notify,
  routeMessageAlerts,
  withMentionLabels,
  type Activity,
  type Db,
  type SelectableGroup,
} from './pingRules.ts';

export type Ctx = {
  db: Db;
  userId: string;
  userEmail: string | null;
  userMeta: { full_name?: string; name?: string };
  push: { url: string; token: string; apikey: string };
  // Service-role client used ONLY for the shared photo library
  // (photo_library rows and the library/ storage folder).
  library: Db;
};

// Meta's Muse groups tools as Read / Write / Sensitive write. Sensitive
// writes tell or affect other people (or can't be undone), and an AI app
// should ask the person every time before running one.
export type ToolClass = 'read' | 'write' | 'sensitive';

type JsonSchema = Record<string, unknown>;
export type Tool = {
  name: string;
  title: string;
  description: string;
  cls: ToolClass;
  // Listed and callable only for the Ping admin account.
  adminOnly?: boolean;
  inputSchema: JsonSchema;
  run: (ctx: Ctx, args: Record<string, unknown>) => Promise<string>;
};

export class ToolError extends Error {}

// ---------- small helpers ----------

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
const int = (v: unknown, dflt: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : dflt);
const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean) : [];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TZ_PROP = {
  type: 'string',
  description:
    "The person's IANA time zone, like America/Denver. Times are read and shown in it. If you don't know it, ask or leave it out (Ping then uses the zone of the person's recent events).",
};
const EVENT_ID_PROP = { type: 'string', description: 'The event id, from list_events or get_event.' };

async function myName(ctx: Ctx): Promise<string> {
  const { data } = await ctx.db.from('profiles').select('full_name').eq('id', ctx.userId).maybeSingle();
  return displayName(
    { full_name: data?.full_name || ctx.userMeta.full_name || ctx.userMeta.name, email: ctx.userEmail },
    'Someone'
  );
}

// The zone to read and show times in: the one asked for, else the zone of
// the person's most recent timed event they host, else Mountain (where
// Discover runs today).
async function zoneFor(ctx: Ctx, asked: unknown): Promise<string> {
  const tz = str(asked);
  if (tz) {
    if (!isValidTimeZone(tz)) throw new ToolError(`"${tz}" isn't a time zone name. Use one like America/Denver.`);
    return tz;
  }
  const { data } = await ctx.db
    .from('events')
    .select('time_zone')
    .eq('host_id', ctx.userId)
    .not('time_zone', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.time_zone && isValidTimeZone(data.time_zone) ? data.time_zone : 'America/Denver';
}

// "2026-11-07T18:00", "2026-11-07 6:00 PM", "2026-11-07" (a date), or a full
// ISO time with an offset. Plain clock times are read in timeZone.
function parseWhen(raw: string, timeZone: string, field: string): { at: Date; dateOnly: boolean } {
  const s = raw.trim();
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(s) && s.includes('T')) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new ToolError(`Couldn't read ${field} "${raw}".`);
    return { at: d, dateOnly: false };
  }
  const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2})?\s*([aApP][mM])?)?$/);
  if (!m) throw new ToolError(`Couldn't read ${field} "${raw}". Use YYYY-MM-DD or YYYY-MM-DDTHH:MM.`);
  const [, y, mo, d, hRaw, mi, ampm] = m;
  if (hRaw === undefined) {
    return { at: instantFromLocal({ y: +y, mo: +mo, d: +d, h: 12, mi: 0 }, timeZone), dateOnly: true };
  }
  let h = +hRaw;
  if (ampm) {
    const pm = ampm.toLowerCase() === 'pm';
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
  }
  return { at: instantFromLocal({ y: +y, mo: +mo, d: +d, h, mi: +mi }, timeZone), dateOnly: false };
}

function whenLabel(e: { event_date: string; end_date: string | null; is_all_day: boolean; time_zone: string | null }, tz: string) {
  // A timed Ping shows in the person's zone; if it was set in another zone,
  // that zone's clock time is added so "6 PM in Phoenix" stays clear.
  const start = formatInZone(e.event_date, tz, e.is_all_day);
  const end = e.end_date ? formatInZone(e.end_date, tz, e.is_all_day) : null;
  let label = end && end !== start ? `${start} – ${end}` : start;
  if (e.is_all_day) label += ' (all day)';
  // Compared by the clock time shown, not the zone name: America/Boise and
  // America/Denver are different names for the same Mountain time.
  if (!e.is_all_day && e.time_zone && e.time_zone !== tz) {
    const there = formatInZone(e.event_date, e.time_zone);
    if (there !== formatInZone(e.event_date, tz)) label += ` [${there} where it happens]`;
  }
  return label;
}

const RSVP_WORDS: Record<string, string> = {
  accepted: 'going',
  interested: 'maybe',
  declined: 'not going',
  pending: 'not answered yet',
};

type EventRow = {
  id: string;
  title: string;
  event_date: string;
  end_date: string | null;
  is_all_day: boolean;
  time_zone: string | null;
  location: string | null;
  description: string | null;
  status: string;
  host_id: string;
  recurrence_id: string | null;
  price_cents: number | null;
  stops: unknown;
};

async function loadEvent(ctx: Ctx, rawId: unknown) {
  const id = str(rawId);
  if (!id || !UUID.test(id)) throw new ToolError('Give an event_id from list_events.');
  const { data: event } = await ctx.db
    .from('events')
    .select('id, title, event_date, end_date, is_all_day, time_zone, location, description, status, host_id, recurrence_id, price_cents, stops')
    .eq('id', id)
    .maybeSingle();
  if (!event) throw new ToolError("That event wasn't found, or it isn't one you're on.");
  const [{ data: coHosts }, { data: mine }] = await Promise.all([
    ctx.db.from('event_hosts').select('user_id').eq('event_id', id),
    ctx.db
      .from('invitees')
      .select('id, rsvp_status, reminder_minutes_before, reminder_push')
      .eq('event_id', id)
      .eq('user_id', ctx.userId)
      .maybeSingle(),
  ]);
  // deno-lint-ignore no-explicit-any
  const hostIds = [event.host_id, ...(coHosts || []).map((h: any) => h.user_id)].filter(Boolean) as string[];
  return {
    event: event as EventRow,
    hostIds,
    isHost: hostIds.includes(ctx.userId),
    myInvitee: (mine as MyInvitee | null) ?? null,
  };
}

type MyInvitee = { id: string; rsvp_status: string; reminder_minutes_before: number | null; reminder_push: boolean };

// The app's reminder choices (lib/eventReminders.ts REMINDER_OPTIONS).
const REMINDER_CHOICES: Record<string, number | null> = { off: null, '30_min': 30, '1_hour': 60, '1_day': 1440 };
const reminderWords = (minutes: number | null) =>
  minutes == null ? 'off' : minutes >= 1440 ? '1 day before' : minutes >= 60 ? '1 hour before' : `${minutes} minutes before`;

function requireHost(isHost: boolean, what: string) {
  if (!isHost) throw new ToolError(`Only the event's hosts can ${what}.`);
}

// ---------- people and groups ----------

type ContactRow = { id: string; name: string; phone: string | null; email: string | null; linked_user_id: string | null };

async function myContacts(ctx: Ctx): Promise<ContactRow[]> {
  const { data, error } = await ctx.db
    .from('contacts')
    .select('id, name, phone, email, linked_user_id')
    .eq('owner_id', ctx.userId)
    .is('removed_at', null)
    .order('name');
  if (error) throw new ToolError("Couldn't load your people.");
  return data || [];
}

async function ownedGroups(ctx: Ctx): Promise<SelectableGroup[]> {
  const { data } = await ctx.db
    .from('groups')
    .select('id, name, group_members(contact_id, contacts(name))')
    .eq('owner_id', ctx.userId)
    .order('name');
  // deno-lint-ignore no-explicit-any
  return (data || []).map((g: any) => ({
    id: g.id,
    name: g.name,
    // deno-lint-ignore no-explicit-any
    members: (g.group_members || []).map((m: any) => ({ contactId: m.contact_id, name: m.contacts?.name || 'Unknown' })),
  }));
}

// Finds one thing by id or by name: exact name first, then a name that
// starts with it, then one that contains it. More than one match is an
// error that lists them, so the AI asks the person which one.
function pickByName<T extends { id: string; name: string }>(items: T[], query: string, kind: string): T {
  const byId = items.find((i) => i.id === query);
  if (byId) return byId;
  const q = query.toLowerCase();
  for (const test of [
    (n: string) => n === q,
    (n: string) => n.startsWith(q),
    (n: string) => n.split(/\s+/).some((w) => w === q),
    (n: string) => n.includes(q),
  ]) {
    const hits = items.filter((i) => test(i.name.toLowerCase()));
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new ToolError(
        `More than one ${kind} matches "${query}": ${hits.map((h) => `${h.name} (${h.id})`).join(', ')}. Ask which one, then pass its id.`
      );
    }
  }
  throw new ToolError(`No ${kind} named "${query}". Use list_people or list_groups to see the names.`);
}

// ---------- stops along the way (lib/stops.ts) ----------

type Stop = { id: string; day: string; name: string; address: string; note?: string };
const MAX_STOPS = 60; // matches the events_stops_is_small_array check
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

function parseStopArgs(raw: unknown[]): Stop[] {
  // deno-lint-ignore no-explicit-any
  return raw.map((s: any, i) => {
    const day = str(s?.day);
    if (!day || !DAY_KEY.test(day)) throw new ToolError(`Stop ${i + 1} needs a day as YYYY-MM-DD.`);
    return { id: crypto.randomUUID(), day, name: str(s?.name) ?? '', address: str(s?.address) ?? '', note: str(s?.note) ?? '' };
  });
}

// cleanStops: blank stops dropped, a day the event no longer covers moved
// onto the nearest one it does, then day order (stable within a day).
function cleanStops(stops: Stop[], start: Date, end: Date | null, tz: string): Stop[] {
  const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
  const first = dayKey(start);
  const last = end && dayKey(end) > first ? dayKey(end) : first;
  return stops
    .filter((s) => typeof s.day === 'string' && (s.name?.trim() || s.address?.trim() || s.note?.trim()))
    .map((s, i) => ({ s: { ...s, day: s.day < first ? first : s.day > last ? last : s.day }, i }))
    .sort((a, b) => (a.s.day === b.s.day ? a.i - b.i : a.s.day < b.s.day ? -1 : 1))
    .map(({ s }) => s)
    .slice(0, MAX_STOPS);
}

// shiftStops: a repeating Ping copies its stops onto each date, moved by
// however many days that date is after the first.
function shiftStops(stops: Stop[], offsetDays: number): Stop[] {
  return stops.map((s) => {
    const [y, m, d] = s.day.split('-').map(Number);
    const moved = new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
    return { ...s, id: crypto.randomUUID(), day: moved };
  });
}

// ---------- repeating events (lib/recurrence.ts) ----------

const MAX_GENERATED_OCCURRENCES = 52;
type Local = { y: number; mo: number; d: number; h: number; mi: number };

// Steps on calendar fields in the event's own zone, so a 6 PM weekly event
// stays 6 PM across a daylight-saving change. Monthly keeps the original
// day, clamped to short months (Jan 31 -> Feb 28).
function advanceLocal(l: Local, frequency: string, interval: number, originalDay: number): Local {
  let y = l.y;
  let mo = l.mo;
  let d = l.d;
  if (frequency === 'daily' || frequency === 'weekly') {
    const t = new Date(Date.UTC(y, mo - 1, d + interval * (frequency === 'weekly' ? 7 : 1)));
    y = t.getUTCFullYear();
    mo = t.getUTCMonth() + 1;
    d = t.getUTCDate();
  } else {
    const months = frequency === 'monthly' ? interval : interval * 12;
    const t = new Date(Date.UTC(y, mo - 1 + months, 1));
    y = t.getUTCFullYear();
    mo = t.getUTCMonth() + 1;
    const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    d = Math.min(originalDay, lastDay);
  }
  return { ...l, y, mo, d };
}

// ---------- tools ----------

const listEvents: Tool = {
  name: 'list_events',
  title: 'List my events',
  cls: 'read',
  description:
    "Lists the person's Ping events (ones they host or were invited to, with their RSVP) and the Discover activities they starred, between two dates. Use it for questions like \"what's on my calendar Friday\". It does not include personal items kept only in the phone's own calendar; those never leave the phone.",
  inputSchema: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Start date, YYYY-MM-DD. Default: today.' },
      to: { type: 'string', description: 'End date, YYYY-MM-DD (included). Default: 14 days after from.' },
      search: { type: 'string', description: 'Only events whose title contains this.' },
      time_zone: TZ_PROP,
    },
  },
  async run(ctx, args) {
    const tz = await zoneFor(ctx, args.time_zone);
    const todayLocal = new Date().toLocaleDateString('en-CA', { timeZone: tz });
    const fromDay = str(args.from) ?? todayLocal;
    const from = parseWhen(fromDay.slice(0, 10), tz, 'from').at;
    from.setTime(from.getTime() - 12 * 3600_000); // noon -> midnight
    const to = str(args.to)
      ? new Date(parseWhen(str(args.to)!.slice(0, 10), tz, 'to').at.getTime() + 12 * 3600_000)
      : new Date(from.getTime() + 15 * 86400_000);
    if (to <= from) throw new ToolError('"to" has to be after "from".');
    const search = str(args.search);

    let q = ctx.db
      .from('invitees')
      .select(
        'rsvp_status, events!inner(id, title, event_date, end_date, is_all_day, time_zone, location, status, host_id, recurrence_id)'
      )
      .eq('user_id', ctx.userId)
      .lt('events.event_date', to.toISOString())
      .or(`end_date.gte.${from.toISOString()},event_date.gte.${from.toISOString()}`, { referencedTable: 'events' })
      .limit(200);
    if (search) q = q.ilike('events.title', `%${search}%`);
    let starredQ = ctx.db
      .from('discover_interests')
      .select('activity_key, title, location, starts_at, ends_at')
      .eq('user_id', ctx.userId)
      .gte('starts_at', from.toISOString())
      .lt('starts_at', to.toISOString())
      .order('starts_at');
    if (search) starredQ = starredQ.ilike('title', `%${search}%`);
    const [{ data: rows, error }, { data: starred }] = await Promise.all([q, starredQ]);
    if (error) throw new ToolError("Couldn't load events.");

    // deno-lint-ignore no-explicit-any
    const events = (rows || []).map((r: any) => ({ ...r.events, rsvp: r.rsvp_status }));
    events.sort((a: EventRow, b: EventRow) => a.event_date.localeCompare(b.event_date));
    const lines: string[] = [`Times in ${tz}. Range: ${formatInZone(from.toISOString(), tz, true)} to ${formatInZone(new Date(to.getTime() - 1).toISOString(), tz, true)}.`];
    if (events.length === 0) lines.push('No Ping events in this range.');
    for (const e of events) {
      const role = e.host_id === ctx.userId ? 'you host' : `you: ${RSVP_WORDS[e.rsvp] ?? e.rsvp}`;
      const extra = [e.status === 'draft' ? 'draft, not sent' : null, e.recurrence_id ? 'repeats' : null].filter(Boolean);
      lines.push(
        `- ${e.title} | ${whenLabel(e, tz)}${e.location ? ` | ${e.location}` : ''} | ${role}${extra.length ? ` (${extra.join(', ')})` : ''} | event_id ${e.id}`
      );
    }
    if ((starred || []).length > 0) {
      lines.push('', 'Starred in Discover:');
      // deno-lint-ignore no-explicit-any
      for (const s of starred as any[]) {
        lines.push(`- ${s.title} | ${formatInZone(s.starts_at, tz)}${s.location ? ` | ${s.location}` : ''} | starred_key ${s.activity_key}`);
      }
    }
    lines.push('', "Personal items in the phone's own calendar aren't included - Ping keeps those on the phone.");
    return lines.join('\n');
  },
};

const getEvent: Tool = {
  name: 'get_event',
  title: 'Event details',
  cls: 'read',
  description:
    "Everything about one event: when and where, hosts, guests and their RSVPs, stops along the way, What to bring (items and who's bringing what) and the latest chat messages.",
  inputSchema: { type: 'object', properties: { event_id: EVENT_ID_PROP, time_zone: TZ_PROP }, required: ['event_id'] },
  async run(ctx, args) {
    const tz = await zoneFor(ctx, args.time_zone);
    const { event, hostIds, isHost, myInvitee } = await loadEvent(ctx, args.event_id);
    const [{ data: guests }, { data: items }, { data: messages }, { data: hostProfiles }] = await Promise.all([
      ctx.db
        .from('invitees')
        .select('id, user_id, rsvp_status, invited_via, profiles(full_name, email), contacts(name)')
        .eq('event_id', event.id),
      ctx.db
        .from('items')
        .select('id, name, quantity_needed, allow_custom, item_claims(id, quantity, note, invitee_id)')
        .eq('event_id', event.id)
        .order('created_at'),
      ctx.db
        .from('messages')
        .select('id, body, created_at, edited_at, sender_id, profiles(full_name, email)')
        .eq('event_id', event.id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .limit(15),
      ctx.db.from('profiles').select('id, full_name, email').in('id', hostIds),
    ]);
    // deno-lint-ignore no-explicit-any
    const guestName = (g: any) => (g.user_id === ctx.userId ? 'You' : g.contacts?.name || displayName(g.profiles));
    // deno-lint-ignore no-explicit-any
    const byInvitee = new Map((guests || []).map((g: any) => [g.id, guestName(g)]));

    const lines = [
      `${event.title}${event.status === 'draft' ? ' (draft, not sent)' : ''}`,
      `When: ${whenLabel(event, tz)}${event.recurrence_id ? ' (repeats)' : ''}`,
      event.location ? `Where: ${event.location}` : null,
      event.description ? `Notes: ${event.description}` : null,
      event.price_cents ? `Price: $${(event.price_cents / 100).toFixed(2)}` : null,
      // deno-lint-ignore no-explicit-any
      `Hosts: ${(hostProfiles || []).map((p: any) => (p.id === ctx.userId ? 'You' : displayName(p))).join(', ')}`,
      `Your RSVP: ${isHost ? 'host' : myInvitee ? RSVP_WORDS[myInvitee.rsvp_status] : 'not on the guest list'}`,
      myInvitee ? `Your reminder: ${reminderWords(myInvitee.reminder_minutes_before)}` : null,
      `event_id: ${event.id}`,
    ].filter(Boolean) as string[];

    // deno-lint-ignore no-explicit-any
    const others = (guests || []).filter((g: any) => !hostIds.includes(g.user_id));
    lines.push('', `Guests (${others.length}):`);
    for (const status of ['accepted', 'interested', 'pending', 'declined']) {
      // deno-lint-ignore no-explicit-any
      const names = others.filter((g: any) => g.rsvp_status === status).map(guestName);
      if (names.length) lines.push(`- ${RSVP_WORDS[status]}: ${names.join(', ')}`);
    }

    const stops = Array.isArray(event.stops) ? event.stops : [];
    if (stops.length) {
      lines.push('', 'Stops along the way:');
      // deno-lint-ignore no-explicit-any
      for (const s of stops as any[]) {
        lines.push(`- ${[s.day, s.time, s.name || s.title, s.location || s.address, s.note].filter(Boolean).join(' · ')}`);
      }
    }

    lines.push('', 'What to bring:');
    if (!items || items.length === 0) lines.push('- nothing listed');
    // deno-lint-ignore no-explicit-any
    for (const it of (items || []) as any[]) {
      // deno-lint-ignore no-explicit-any
      const claims = (it.item_claims || []) as any[];
      if (it.allow_custom) {
        const entries = claims.map((c) => `${byInvitee.get(c.invitee_id) ?? 'Someone'}: ${c.note ?? ''}`.trim());
        lines.push(`- ${it.name} (open list, anyone can add) - ${entries.length ? entries.join('; ') : 'nothing yet'} | item_id ${it.id}`);
      } else {
        const taken = claims.reduce((n, c) => n + c.quantity, 0);
        const who = claims.map((c) => `${byInvitee.get(c.invitee_id) ?? 'Someone'} ×${c.quantity}`);
        lines.push(`- ${it.name}: ${taken}/${it.quantity_needed} covered${who.length ? ` (${who.join(', ')})` : ''} | item_id ${it.id}`);
      }
    }

    lines.push('', 'Latest chat (newest last):');
    if (!messages || messages.length === 0) lines.push('- no messages');
    // deno-lint-ignore no-explicit-any
    for (const m of [...(messages || [])].reverse() as any[]) {
      const mine = m.sender_id === ctx.userId;
      lines.push(
        `- ${mine ? 'You' : displayName(m.profiles)} (${formatInZone(m.created_at, tz)}${m.edited_at ? ', edited' : ''}): ${m.body}${mine ? ` | message_id ${m.id}` : ''}`
      );
    }
    return lines.join('\n');
  },
};

const listGroups: Tool = {
  name: 'list_groups',
  title: 'List my groups',
  cls: 'read',
  description: "The person's groups (their own, and ones shared with them) and who is in each. Groups can be invited all at once with invite_people.",
  inputSchema: { type: 'object', properties: {} },
  async run(ctx) {
    const owned = await ownedGroups(ctx);
    const { data: sharedRows } = await ctx.db
      .from('groups')
      .select('id, name, group_members(contacts(name))')
      .neq('owner_id', ctx.userId)
      .order('name');
    const lines: string[] = [];
    for (const g of owned) lines.push(`- ${g.name} (${g.members.length}): ${g.members.map((m) => m.name).join(', ') || 'empty'} | group_id ${g.id}`);
    // deno-lint-ignore no-explicit-any
    for (const g of (sharedRows || []) as any[]) {
      // deno-lint-ignore no-explicit-any
      const names = (g.group_members || []).map((m: any) => m.contacts?.name || 'Someone');
      lines.push(`- ${g.name} (shared with you, ${names.length}): ${names.join(', ')} | group_id ${g.id}`);
    }
    return lines.length ? lines.join('\n') : 'No groups yet - create_group makes one.';
  },
};

const listPeople: Tool = {
  name: 'list_people',
  title: 'List my people',
  cls: 'read',
  description:
    "The people the person can invite (their Ping contacts), and whether each has the Ping app. People without the app get their invite by text from the person's phone.",
  inputSchema: { type: 'object', properties: { search: { type: 'string', description: 'Only names containing this.' } } },
  async run(ctx, args) {
    const search = str(args.search)?.toLowerCase();
    const people = (await myContacts(ctx)).filter((c) => !search || c.name.toLowerCase().includes(search));
    if (people.length === 0) return search ? `Nobody named "${args.search}".` : 'No people yet.';
    return people
      .map((c) => {
        const last4 = normalizePhone(c.phone)?.slice(-4);
        return `- ${c.name}${last4 ? ` (phone ending ${last4})` : ''}${c.linked_user_id ? ' - has Ping' : ' - no Ping app'} | person_id ${c.id}`;
      })
      .join('\n');
  },
};

const DISCOVER_CATEGORIES = ['movies', 'music', 'dance', 'carnival', 'farmers_market', 'family', 'sports', 'community'];

async function discoverActivities(ctx: Ctx, from: Date, to: Date): Promise<Activity[]> {
  const [{ data, error }, { data: listings }] = await Promise.all([
    ctx.db
      .from('activities')
      .select('id, source, title, category, description, location, lat, lng, starts_at, ends_at, price_label, url, time_tba')
      .gte('starts_at', from.toISOString())
      .lte('starts_at', to.toISOString())
      .order('starts_at')
      .limit(1000),
    ctx.db
      .from('events')
      .select('id, title, description, location, event_date, end_date, discover_category, price_cents')
      .eq('discoverable', true)
      .eq('status', 'sent')
      .gte('event_date', from.toISOString())
      .lte('event_date', to.toISOString()),
  ]);
  if (error) throw new ToolError("Couldn't load Discover.");
  // deno-lint-ignore no-explicit-any
  const acts: Activity[] = (data || []).map((r: any) => ({
    id: r.id,
    source: r.source,
    title: r.title,
    category: DISCOVER_CATEGORIES.includes(r.category) ? r.category : 'community',
    description: r.description,
    location: r.location,
    lat: r.lat,
    lng: r.lng,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    priceLabel: r.price_label,
    url: r.url,
    timeTba: r.time_tba,
  }));
  // deno-lint-ignore no-explicit-any
  const pings: Activity[] = (listings || []).map((r: any) => ({
    id: `ping-${r.id}`,
    source: 'ping',
    title: r.title,
    category: DISCOVER_CATEGORIES.includes(r.discover_category) ? r.discover_category : 'community',
    description: r.description,
    location: r.location,
    lat: null,
    lng: null,
    startsAt: r.event_date,
    endsAt: r.end_date,
    priceLabel: r.price_cents ? `$${(r.price_cents / 100).toFixed(2)}` : null,
    url: null,
    pingEventId: r.id,
  }));
  return [...dedupeActivities(acts), ...pings].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

const searchDiscover: Tool = {
  name: 'search_discover',
  title: 'Search Discover',
  cls: 'read',
  description:
    'Searches Discover, the local activities near the person (concerts, games, markets, movies, family events, and events people listed on Ping). Discover covers the Utah (Wasatch Front) and Boise areas today.',
  inputSchema: {
    type: 'object',
    properties: {
      date: { type: 'string', description: 'One day, YYYY-MM-DD. Leave out to look ahead days_ahead days.' },
      days_ahead: { type: 'number', description: 'Days to look ahead from today when no date is given. Default 7, max 31.' },
      search: { type: 'string', description: 'Words in the title, place or description.' },
      category: { type: 'string', enum: DISCOVER_CATEGORIES },
      area: { type: 'string', enum: ['utah', 'boise'], description: 'Default utah.' },
      time_zone: TZ_PROP,
    },
  },
  async run(ctx, args) {
    const tz = await zoneFor(ctx, args.time_zone);
    let from: Date;
    let to: Date;
    if (str(args.date)) {
      const noon = parseWhen(str(args.date)!.slice(0, 10), tz, 'date').at;
      from = new Date(noon.getTime() - 12 * 3600_000);
      to = new Date(noon.getTime() + 12 * 3600_000);
    } else {
      from = new Date();
      to = new Date(Date.now() + Math.min(Math.max(int(args.days_ahead, 7), 1), 31) * 86400_000);
    }
    const area = args.area === 'boise' ? 'boise' : 'utah';
    const search = str(args.search)?.toLowerCase();
    const category = str(args.category);
    let list = (await discoverActivities(ctx, from, to)).filter((a) => {
      const r = areaOfActivity(a);
      return r === null || r === area;
    });
    if (category) list = list.filter((a) => a.category === category);
    if (search) {
      list = list.filter((a) => [a.title, a.location, a.description].some((t) => t?.toLowerCase().includes(search)));
    }
    if (list.length === 0) return 'Nothing in Discover for that.';
    const { data: starredRows } = await ctx.db.from('discover_interests').select('activity_key').eq('user_id', ctx.userId);
    // deno-lint-ignore no-explicit-any
    const starred = new Set((starredRows || []).map((r: any) => r.activity_key));
    const shown = list.slice(0, 40);
    const lines = shown.map(
      (a) =>
        `- ${a.title} | ${a.timeTba ? `${formatInZone(a.startsAt, tz, true)}, time TBA` : formatInZone(a.startsAt, tz)}${a.location ? ` | ${a.location}` : ''}${a.priceLabel ? ` | ${a.priceLabel}` : ''} | ${a.category}${starred.has(activityKey(a)) ? ' | ★ starred' : ''} | activity_id ${a.id}`
    );
    if (list.length > shown.length) lines.push(`(${list.length - shown.length} more - narrow the search to see them)`);
    return lines.join('\n');
  },
};

// ---------- writes ----------

const createEvent: Tool = {
  name: 'create_event',
  title: 'New Event',
  cls: 'write',
  description:
    "Makes a New Event in Ping, hosted by the person. It starts with just them on it; use invite_people next to invite people or a group. Confirm the title, day and time with the person if anything is unclear.",
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      start: { type: 'string', description: 'YYYY-MM-DDTHH:MM in time_zone, or YYYY-MM-DD for an all-day event.' },
      end: { type: 'string', description: 'Same format. Default: one hour after start (timed events).' },
      all_day: { type: 'boolean', description: 'Default: true when start has no time.' },
      location: { type: 'string' },
      description: { type: 'string', description: 'Notes shown on the event.' },
      bring_items: {
        type: 'array',
        description: 'What to bring list to start with.',
        items: { type: 'object', properties: { name: { type: 'string' }, quantity: { type: 'number' } }, required: ['name'] },
      },
      time_zone: TZ_PROP,
    },
    required: ['title', 'start'],
  },
  async run(ctx, args) {
    const title = str(args.title);
    if (!title) throw new ToolError('A title is needed.');
    const tz = await zoneFor(ctx, args.time_zone);
    const start = parseWhen(str(args.start) ?? '', tz, 'start');
    const allDay = bool(args.all_day, start.dateOnly);
    let end: Date | null = str(args.end) ? parseWhen(str(args.end)!, tz, 'end').at : null;
    if (!end && !allDay) end = new Date(start.at.getTime() + 3600_000);
    if (end && end.getTime() < start.at.getTime()) throw new ToolError('The end is before the start.');

    const { data: eventRow, error } = await ctx.db
      .from('events')
      .insert([
        {
          title,
          description: str(args.description) ?? null,
          location: str(args.location) ?? '',
          stops: [],
          event_date: start.at.toISOString(),
          end_date: end ? end.toISOString() : null,
          time_zone: allDay ? null : tz,
          is_all_day: allDay,
          status: 'sent',
          host_id: ctx.userId,
          is_public: false,
          discoverable: false,
        },
      ])
      .select('id, title, event_date, end_date, is_all_day, time_zone')
      .single();
    if (error || !eventRow) throw new ToolError(`Couldn't make the event${error?.message ? `: ${error.message}` : ''}.`);

    // Same as the app: the host always has their own accepted invitee row -
    // Home only shows events you have a row on.
    const { error: hostErr } = await ctx.db.from('invitees').insert([
      { event_id: eventRow.id, user_id: ctx.userId, rsvp_status: 'accepted', invited_via: 'app', responded_at: new Date().toISOString() },
    ]);
    if (hostErr) console.error('Error creating host invitee row:', hostErr);

    // deno-lint-ignore no-explicit-any
    const items = (Array.isArray(args.bring_items) ? args.bring_items : []) as any[];
    const itemRows = items
      .filter((i) => str(i?.name))
      .map((i) => ({ event_id: eventRow.id, name: str(i.name), quantity_needed: Math.max(int(i.quantity, 1), 1), allow_custom: false }));
    if (itemRows.length) {
      const { error: itemsErr } = await ctx.db.from('items').insert(itemRows);
      if (itemsErr) console.error('Error creating items:', itemsErr);
    }
    return `Made "${title}" for ${whenLabel(eventRow, tz)}. event_id ${eventRow.id}. Nobody's invited yet - use invite_people to invite people or a group.`;
  },
};

const editEvent: Tool = {
  name: 'edit_event',
  title: 'Edit event',
  cls: 'write',
  description:
    "Changes an event the person hosts: title, time, place, notes, or its stops along the way (where the group is each day of a trip). Guests who haven't declined are told it changed unless notify_guests is false. For a repeating event this changes just this one date.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      title: { type: 'string' },
      start: { type: 'string', description: 'YYYY-MM-DDTHH:MM in time_zone, or YYYY-MM-DD for all day.' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      location: { type: 'string' },
      description: { type: 'string' },
      stops: {
        type: 'array',
        description:
          'The full new list of stops along the way - it replaces the current list, so include the ones to keep (get_event shows them). An empty list removes them all. A day outside the event\'s dates moves to the nearest day it covers.',
        items: {
          type: 'object',
          properties: {
            day: { type: 'string', description: 'YYYY-MM-DD.' },
            name: { type: 'string', description: 'Like "Holiday Inn Moab".' },
            address: { type: 'string' },
            note: { type: 'string', description: 'Anything guests should know about this stop, like "check-in after 3 PM".' },
          },
          required: ['day'],
        },
      },
      notify_guests: { type: 'boolean', description: 'Default true.' },
      time_zone: TZ_PROP,
    },
    required: ['event_id'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'edit it');
    const tz = str(args.time_zone) ? await zoneFor(ctx, args.time_zone) : event.time_zone || (await zoneFor(ctx, undefined));
    // deno-lint-ignore no-explicit-any
    const updates: Record<string, any> = {};
    if (str(args.title)) updates.title = str(args.title);
    if (typeof args.location === 'string') updates.location = args.location.trim();
    if (typeof args.description === 'string') updates.description = args.description.trim() || null;
    const timesChanged = !!(str(args.start) || str(args.end) || typeof args.all_day === 'boolean');
    if (timesChanged) {
      const start = str(args.start) ? parseWhen(str(args.start)!, tz, 'start') : { at: new Date(event.event_date), dateOnly: event.is_all_day };
      const allDay = bool(args.all_day, str(args.start) ? start.dateOnly : event.is_all_day);
      let end: Date | null;
      if (str(args.end)) end = parseWhen(str(args.end)!, tz, 'end').at;
      else if (event.end_date && str(args.start)) {
        // Moving the start keeps the length the same.
        end = new Date(start.at.getTime() + (new Date(event.end_date).getTime() - new Date(event.event_date).getTime()));
      } else end = event.end_date ? new Date(event.end_date) : null;
      if (end && end < start.at) throw new ToolError('The end is before the start.');
      updates.event_date = start.at.toISOString();
      updates.end_date = end ? end.toISOString() : null;
      updates.is_all_day = allDay;
      updates.time_zone = allDay ? null : tz;
    }
    const newStops = Array.isArray(args.stops) ? parseStopArgs(args.stops) : null;
    const currentStops = Array.isArray(event.stops) ? (event.stops as Stop[]) : [];
    if (newStops || (timesChanged && currentStops.length)) {
      const start = new Date(updates.event_date ?? event.event_date);
      const endIso = 'end_date' in updates ? updates.end_date : event.end_date;
      updates.stops = cleanStops(newStops ?? currentStops, start, endIso ? new Date(endIso) : null, tz);
    }
    if (Object.keys(updates).length === 0) return 'Nothing to change.';
    const { error } = await ctx.db.from('events').update(updates).eq('id', event.id);
    if (error) throw new ToolError(`Couldn't save the change${error.message ? `: ${error.message}` : ''}.`);

    let told = 0;
    if (bool(args.notify_guests, true)) {
      const { data: allInvitees } = await ctx.db.from('invitees').select('user_id, rsvp_status').eq('event_id', event.id);
      const recipients = (allInvitees || [])
        // deno-lint-ignore no-explicit-any
        .filter((i: any) => i.rsvp_status !== 'declined')
        // deno-lint-ignore no-explicit-any
        .map((i: any) => i.user_id)
        .filter((id: string | null) => !!id && id !== ctx.userId);
      const title = updates.title ?? event.title;
      await notify(ctx.db, ctx.push, recipients, `${title} was updated`, "The host changed this event's details — take a look.", {
        eventId: event.id,
        type: 'event_updated',
      });
      told = recipients.length;
    }
    const after = { ...event, ...updates };
    const stopsNote = newStops
      ? ` Stops along the way: ${(updates.stops as Stop[]).length ? (updates.stops as Stop[]).map((s) => `${s.day} ${s.name || s.address}`).join('; ') : 'none'}.`
      : '';
    return `Saved. "${after.title}" is now ${whenLabel(after, tz)}${after.location ? ` at ${after.location}` : ''}.${stopsNote}${told ? ` ${told} guest${told === 1 ? ' was' : 's were'} told.` : ''}`;
  },
};

const cancelEvent: Tool = {
  name: 'cancel_event',
  title: 'Cancel event',
  cls: 'sensitive',
  description:
    "Cancels (deletes) an event the person hosts, with its guest list, What to bring and chat. This can't be undone - always confirm with the person first. Guests with Ping are told unless notify_guests is false; guests without the app need a text from the person.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      notify_guests: { type: 'boolean', description: 'Default true.' },
      include_later_repeats: { type: 'boolean', description: 'For a repeating event, also cancel every later date. Default false.' },
    },
    required: ['event_id'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'cancel it');
    const applyToFuture = bool(args.include_later_repeats, false) && !!event.recurrence_id;

    // Mirrors lib/deleteEvent.ts.
    let eventIds = [event.id];
    if (applyToFuture) {
      const { data: siblings } = await ctx.db
        .from('events')
        .select('id')
        .eq('recurrence_id', event.recurrence_id)
        .gte('event_date', event.event_date);
      // deno-lint-ignore no-explicit-any
      if (siblings?.length) eventIds = siblings.map((r: any) => r.id);
    }
    let unreachable: string[] = [];
    if (bool(args.notify_guests, true)) {
      const { data: allInvitees } = await ctx.db
        .from('invitees')
        .select('user_id, invited_via, contacts(name, phone)')
        .eq('event_id', event.id);
      // deno-lint-ignore no-explicit-any
      const recipients = (allInvitees || []).map((i: any) => i.user_id).filter((id: string | null) => !!id && id !== ctx.userId);
      await notify(
        ctx.db,
        ctx.push,
        recipients,
        'Event canceled',
        applyToFuture ? `"${event.title}" and its remaining repeats have been canceled.` : `"${event.title}" has been canceled.`,
        { eventId: event.id, type: 'event_canceled' }
      );
      unreachable = (allInvitees || [])
        // deno-lint-ignore no-explicit-any
        .filter((i: any) => !i.user_id && i.invited_via === 'sms' && i.contacts?.phone)
        // deno-lint-ignore no-explicit-any
        .map((i: any) => i.contacts?.name || 'Guest');
    }
    const { data: eventItems } = await ctx.db.from('items').select('id').in('event_id', eventIds);
    // deno-lint-ignore no-explicit-any
    const itemIds = (eventItems || []).map((i: any) => i.id);
    if (itemIds.length) await ctx.db.from('item_claims').delete().in('item_id', itemIds);
    await ctx.db.from('items').delete().in('event_id', eventIds);
    await ctx.db.from('messages').delete().in('event_id', eventIds);
    await ctx.db.from('invitees').delete().in('event_id', eventIds);
    await ctx.db.from('event_hosts').delete().in('event_id', eventIds);
    const { error } = await ctx.db.from('events').delete().in('id', eventIds);
    if (error) throw new ToolError(`Couldn't cancel it${error.message ? `: ${error.message}` : ''}.`);
    let out = `Canceled "${event.title}"${eventIds.length > 1 ? ` and ${eventIds.length - 1} later date(s)` : ''}.`;
    if (unreachable.length) out += ` ${unreachable.join(', ')} don't have Ping, so they weren't told - text them yourself.`;
    return out;
  },
};

const invitePeople: Tool = {
  name: 'invite_people',
  title: 'Invite People',
  cls: 'sensitive',
  description:
    "Invites people and/or whole groups to an event. People with Ping get an invite right away. People without the app are added to the guest list, and the person sends them the invite by text from the Ping app on their phone. Names are matched against list_people and list_groups; if a name matches more than one, ask which.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      people: { type: 'array', items: { type: 'string' }, description: 'Names or person_ids.' },
      groups: { type: 'array', items: { type: 'string' }, description: 'Group names or group_ids. Everyone in the group is invited.' },
    },
    required: ['event_id'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'invite people');
    const peopleAsked = strList(args.people);
    const groupsAsked = strList(args.groups);
    if (!peopleAsked.length && !groupsAsked.length) throw new ToolError('Say who to invite: people, groups, or both.');

    let contacts = await myContacts(ctx);
    let groups = await ownedGroups(ctx);
    if (groupsAsked.length) {
      // Groups shared with you - same as the app, their members become your
      // contacts so the invite flow can use them.
      const { groups: memberGroups, newContacts } = await loadMemberGroups(ctx.db, ctx.userId, contacts);
      groups = [...groups, ...memberGroups];
      contacts = [...contacts, ...newContacts];
    }
    const picked = new Set<string>();
    for (const g of groupsAsked) pickByName(groups, g, 'group').members.forEach((m) => picked.add(m.contactId));
    for (const p of peopleAsked) picked.add(pickByName(contacts, p, 'person').id);

    // Same checks as ShareInviteModal: skip anyone already on the event (by
    // phone, then by account), heal stale account links, then insert.
    const alreadyPhones = await getAlreadyInvitedPhones(ctx.db, event.id);
    const { data: existing } = await ctx.db.from('invitees').select('contact_id').eq('event_id', event.id);
    // deno-lint-ignore no-explicit-any
    const existingContactIds = new Set((existing || []).map((r: any) => r.contact_id).filter(Boolean));
    const toInvite: ContactRow[] = [];
    const skipped: string[] = [];
    for (const cid of picked) {
      const c = contacts.find((x) => x.id === cid);
      if (!c) continue;
      const phone = normalizePhone(c.phone);
      if (existingContactIds.has(cid) || (phone && alreadyPhones.has(phone))) {
        skipped.push(c.name);
        continue;
      }
      if (phone) alreadyPhones.add(phone);
      toInvite.push(c);
    }
    const healed = await Promise.all(toInvite.map((c) => healContactLink(ctx.db, c)));
    const rows = await dropAccountsAlreadyInvited(
      ctx.db,
      event.id,
      healed
        .filter((c) => c.linked_user_id !== ctx.userId)
        .map((c) => ({
          event_id: event.id,
          contact_id: c.id,
          user_id: c.linked_user_id || null,
          rsvp_status: 'pending',
          invited_via: c.linked_user_id ? 'app' : c.phone ? 'sms' : 'email',
        }))
    );
    const invitedIds = new Set(rows.map((r) => r.contact_id));
    for (const c of healed) if (!invitedIds.has(c.id) && !skipped.includes(c.name)) skipped.push(c.name);
    if (rows.length === 0) {
      return skipped.length ? `Everyone asked is already on "${event.title}" (${skipped.join(', ')}).` : 'Nobody to invite.';
    }
    const { error } = await ctx.db.from('invitees').insert(rows);
    if (error) throw new ToolError(`Invites didn't go out${error.message ? `: ${error.message}` : ''}.`);

    const userIds = rows.map((r) => r.user_id).filter(Boolean) as string[];
    if (event.status === 'sent') {
      await notify(ctx.db, ctx.push, userIds, "You're invited! 🎉", `${event.title} — tap to view and RSVP${event.recurrence_id ? ' (repeats)' : ''}`, {
        eventId: event.id,
        type: 'invite',
      });
    }
    const name = (cid: string) => healed.find((c) => c.id === cid)?.name ?? 'Someone';
    const withApp = rows.filter((r) => r.user_id).map((r) => name(r.contact_id));
    const noApp = rows.filter((r) => !r.user_id).map((r) => name(r.contact_id));
    const out = [`Invited to "${event.title}":`];
    if (withApp.length) out.push(`- Got the invite in Ping: ${withApp.join(', ')}`);
    if (noApp.length) out.push(`- On the guest list but don't have Ping (send their invite by text from the Ping app): ${noApp.join(', ')}`);
    if (skipped.length) out.push(`- Already on it: ${skipped.join(', ')}`);
    if (event.status !== 'sent') out.push('The event is still a draft, so nobody was notified yet. Send it from the app.');
    return out.join('\n');
  },
};

const rsvp: Tool = {
  name: 'rsvp',
  title: 'RSVP',
  cls: 'sensitive',
  description:
    "Answers an invite: going, maybe, or not going. The hosts are told. Not going also gives back anything the person signed up to bring. For a repeating event, all_upcoming_dates answers every date from this one on.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      response: { type: 'string', enum: ['going', 'maybe', 'not_going'] },
      all_upcoming_dates: { type: 'boolean', description: 'Default false.' },
    },
    required: ['event_id', 'response'],
  },
  async run(ctx, args) {
    const status = ({ going: 'accepted', maybe: 'interested', not_going: 'declined' } as Record<string, string>)[String(args.response)];
    if (!status) throw new ToolError('response must be going, maybe or not_going.');
    const { event, hostIds, isHost, myInvitee } = await loadEvent(ctx, args.event_id);
    if (isHost && event.host_id === ctx.userId) throw new ToolError("You're the host, so you're already going.");
    if (!myInvitee) throw new ToolError("You're not on this event's guest list, so there's nothing to answer.");
    if (status === 'accepted' && event.price_cents && event.price_cents > 0 && myInvitee.rsvp_status !== 'accepted') {
      throw new ToolError('This event has a ticket price, so saying yes means paying in the Ping app. Open the event in Ping to get a ticket.');
    }
    const now = new Date().toISOString();
    // Mirrors lib/rsvp.ts (submitRsvp / submitSeriesRsvp).
    let inviteeIds = [myInvitee.id];
    let eventIds = [event.id];
    if (bool(args.all_upcoming_dates, false) && event.recurrence_id) {
      const fromDate = event.event_date < now ? event.event_date : now;
      const { data } = await ctx.db
        .from('invitees')
        .select('id, events!inner(id, event_date, recurrence_id)')
        .eq('user_id', ctx.userId)
        .eq('events.recurrence_id', event.recurrence_id)
        .gte('events.event_date', fromDate);
      // deno-lint-ignore no-explicit-any
      if (data?.length) {
        // deno-lint-ignore no-explicit-any
        inviteeIds = data.map((r: any) => r.id);
        // deno-lint-ignore no-explicit-any
        eventIds = data.map((r: any) => r.events.id);
      }
    }
    const patch = { rsvp_status: status, responded_at: now };
    let updated = inviteeIds;
    const { error } = await ctx.db.from('invitees').update(patch).in('id', inviteeIds);
    if (error) {
      // A full date refuses 'accepted' (discover_capacity.sql) - try one by one.
      updated = [];
      for (const id of inviteeIds) {
        const { error: oneErr } = await ctx.db.from('invitees').update(patch).eq('id', id);
        if (!oneErr) updated.push(id);
      }
      if (updated.length === 0) {
        throw new ToolError(error.code === '42501' ? 'This event is full. You can still answer maybe.' : "Couldn't save your answer.");
      }
    }
    await ctx.db
      .from('notifications')
      .update({ read_at: now })
      .eq('recipient_id', ctx.userId)
      .eq('type', 'invite')
      .in('event_id', eventIds)
      .is('read_at', null);
    if (status === 'declined') await ctx.db.from('item_claims').delete().in('invitee_id', updated);
    const word = status === 'accepted' ? 'accepted' : status === 'declined' ? 'declined' : 'is interested in';
    const scope = updated.length > 1 ? ` (all ${updated.length} upcoming dates)` : '';
    await notify(ctx.db, ctx.push, hostIds.filter((id) => id !== ctx.userId), 'RSVP update', `${await myName(ctx)} ${word} ${event.title}${scope}`, {
      eventId: event.id,
      type: 'rsvp_update',
    });
    return `You're now "${RSVP_WORDS[status]}" for "${event.title}"${scope}. The host was told.${updated.length < inviteeIds.length ? ` ${inviteeIds.length - updated.length} date(s) were full and weren't changed.` : ''}`;
  },
};

const addBringItem: Tool = {
  name: 'add_bring_item',
  title: 'Add to What to bring',
  cls: 'write',
  description:
    "Adds something to an event's What to bring. Hosts add a new item to the list. A guest can't add items, but can write in what they're bringing on an open list (one marked \"anyone can add\") - this tool does that for a guest when the event has one.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      name: { type: 'string', description: 'What to bring, like "chips".' },
      quantity: { type: 'number', description: 'How many are needed (hosts only). Default 1.' },
    },
    required: ['event_id', 'name'],
  },
  async run(ctx, args) {
    const name = str(args.name);
    if (!name) throw new ToolError('Say what to add.');
    const { event, isHost, myInvitee } = await loadEvent(ctx, args.event_id);
    if (isHost) {
      const { error } = await ctx.db
        .from('items')
        .insert([{ event_id: event.id, name, quantity_needed: Math.max(int(args.quantity, 1), 1), allow_custom: false }]);
      if (error) throw new ToolError("Couldn't add it.");
      return `Added "${name}" to What to bring for "${event.title}".`;
    }
    if (!myInvitee) throw new ToolError("You're not on this event.");
    const { data: openLists } = await ctx.db.from('items').select('id, name').eq('event_id', event.id).eq('allow_custom', true);
    if (!openLists || openLists.length === 0) {
      throw new ToolError(
        "Only the host can add items to this event's What to bring. Use get_event to see the list and claim_bring_item to sign up for something on it."
      );
    }
    const list = openLists[0];
    const { error } = await ctx.db.from('item_claims').insert([{ item_id: list.id, invitee_id: myInvitee.id, quantity: 1, note: name }]);
    if (error) {
      if (error.code === '23505') return `You already have "${name}" on "${list.name}".`;
      throw new ToolError("Couldn't add it.");
    }
    return `Added "${name}" under "${list.name}" for "${event.title}".`;
  },
};

const claimBringItem: Tool = {
  name: 'claim_bring_item',
  title: 'Bring something',
  cls: 'write',
  description:
    "Signs the person up to bring an item already on an event's What to bring list (or changes how many they're bringing). Quantity 0 takes them off it. The hosts are told when someone signs up.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      item: { type: 'string', description: 'Item name or item_id from get_event.' },
      quantity: { type: 'number', description: 'How many they will bring in total. Default 1.' },
    },
    required: ['event_id', 'item'],
  },
  async run(ctx, args) {
    const { event, hostIds, isHost, myInvitee } = await loadEvent(ctx, args.event_id);
    if (!myInvitee) throw new ToolError("Answer the invite first, then sign up to bring something.");
    const { data: items } = await ctx.db
      .from('items')
      .select('id, name, quantity_needed, allow_custom, item_claims(id, quantity, invitee_id)')
      .eq('event_id', event.id);
    // deno-lint-ignore no-explicit-any
    const item = pickByName((items || []) as any[], str(args.item) ?? '', 'item');
    if (item.allow_custom) throw new ToolError(`"${item.name}" is an open list - use add_bring_item to write in what you're bringing.`);
    // deno-lint-ignore no-explicit-any
    const claims = (item.item_claims || []) as any[];
    const mine = claims.find((c) => c.invitee_id === myInvitee.id);
    const others = claims.filter((c) => c.invitee_id !== myInvitee.id).reduce((n, c) => n + c.quantity, 0);
    const want = Math.max(int(args.quantity, 1), 0);
    if (want > item.quantity_needed - others) {
      throw new ToolError(`Only ${Math.max(item.quantity_needed - others, 0)} more "${item.name}" ${item.quantity_needed - others === 1 ? 'is' : 'are'} needed.`);
    }
    // deno-lint-ignore no-explicit-any
    let error: any = null;
    if (want === 0) {
      if (mine) ({ error } = await ctx.db.from('item_claims').delete().eq('id', mine.id));
    } else if (mine) {
      ({ error } = await ctx.db.from('item_claims').update({ quantity: want }).eq('id', mine.id));
    } else {
      ({ error } = await ctx.db.from('item_claims').insert([{ item_id: item.id, invitee_id: myInvitee.id, quantity: want }]));
    }
    if (error) {
      if (String(error.message).includes('item_full')) throw new ToolError(`Someone else just signed up for "${item.name}".`);
      throw new ToolError("Couldn't save that.");
    }
    if (want > (mine?.quantity ?? 0) && !isHost) {
      await notify(ctx.db, ctx.push, hostIds, 'Someone is bringing something', `${await myName(ctx)} is bringing "${item.name}" to ${event.title}`, {
        eventId: event.id,
        type: 'item_claimed',
      });
    }
    return want === 0 ? `You're no longer bringing "${item.name}".` : `You're bringing ${want} × "${item.name}" to "${event.title}".`;
  },
};

const postMessage: Tool = {
  name: 'post_message',
  title: 'Post in event chat',
  cls: 'sensitive',
  description:
    "Posts a message in an event's chat as the person. Everyone on the event can see it and gets a notification. Show the person the exact words before posting. @FirstName mentions a guest.",
  inputSchema: {
    type: 'object',
    properties: { event_id: EVENT_ID_PROP, text: { type: 'string' } },
    required: ['event_id', 'text'],
  },
  async run(ctx, args) {
    const body = str(args.text);
    if (!body) throw new ToolError('The message is empty.');
    if (body.length > 4000) throw new ToolError('That message is too long.');
    const { event } = await loadEvent(ctx, args.event_id);
    const { data: inserted, error } = await ctx.db
      .from('messages')
      .insert([{ event_id: event.id, sender_id: ctx.userId, body }])
      .select('id')
      .single();
    if (error || !inserted) throw new ToolError("Couldn't post it - the chat may be turned off, or you're not on this event.");
    if (await flagIfObjectionable(ctx.db, body, { userId: ctx.userId, contentType: 'message', contentId: inserted.id, eventId: event.id })) {
      await notify(ctx.db, ctx.push, [ADMIN_USER_ID], 'New report', 'Auto-flagged message content', { type: 'report' });
    }
    // Same routing as MessageThread: @mentions, then everyone else who
    // hasn't declined; muted guests get a silent notification.
    const { data: otherInvitees } = await ctx.db
      .from('invitees')
      .select('user_id, muted, rsvp_status, profiles(full_name, email)')
      .eq('event_id', event.id)
      .neq('user_id', ctx.userId)
      .not('user_id', 'is', null);
    // deno-lint-ignore no-explicit-any
    const guests = (otherInvitees || []) as any[];
    const labels = withMentionLabels(guests.map((g) => ({ userId: g.user_id, fullName: displayName(g.profiles) })));
    const { mentioned, normal, silent } = routeMessageAlerts(guests, findMentionedUserIds(body, labels));
    const sender = await myName(ctx);
    const notifTitle = `New message — ${event.title}`;
    const notifBody = `${sender}: ${body}`;
    await notify(ctx.db, ctx.push, mentioned, `${sender} mentioned you — ${event.title}`, body, { eventId: event.id, type: 'message' });
    await notify(ctx.db, ctx.push, normal, notifTitle, notifBody, { eventId: event.id, type: 'message' });
    await notify(ctx.db, ctx.push, silent, notifTitle, notifBody, { eventId: event.id, type: 'message', silent: true });
    return `Posted in "${event.title}" chat.`;
  },
};

const starDiscover: Tool = {
  name: 'star_discover',
  title: 'Star in Discover',
  cls: 'write',
  description: "Stars a Discover activity so it shows on the person's calendar in Ping. Use an activity_id from search_discover.",
  inputSchema: { type: 'object', properties: { activity_id: { type: 'string' } }, required: ['activity_id'] },
  async run(ctx, args) {
    const id = str(args.activity_id) ?? '';
    let a: Activity | null = null;
    if (id.startsWith('ping-')) {
      const { data: e } = await ctx.db
        .from('events')
        .select('id, title, description, location, event_date, end_date, discover_category, price_cents')
        .eq('id', id.slice(5))
        .eq('discoverable', true)
        .maybeSingle();
      if (e) {
        a = {
          id,
          source: 'ping',
          title: e.title,
          category: e.discover_category || 'community',
          description: e.description,
          location: e.location,
          lat: null,
          lng: null,
          startsAt: e.event_date,
          endsAt: e.end_date,
          priceLabel: e.price_cents ? `$${(e.price_cents / 100).toFixed(2)}` : null,
          url: null,
        };
      }
    } else if (UUID.test(id)) {
      const { data: r } = await ctx.db
        .from('activities')
        .select('id, source, title, category, description, location, lat, lng, starts_at, ends_at, price_label, url')
        .eq('id', id)
        .maybeSingle();
      if (r) {
        a = {
          id: r.id,
          source: r.source,
          title: r.title,
          category: DISCOVER_CATEGORIES.includes(r.category) ? r.category : 'community',
          description: r.description,
          location: r.location,
          lat: r.lat,
          lng: r.lng,
          startsAt: r.starts_at,
          endsAt: r.ends_at,
          priceLabel: r.price_label,
          url: r.url,
        };
      }
    }
    if (!a) throw new ToolError('That activity is gone from Discover - search again for a fresh activity_id.');
    // Same snapshot the app stores (lib/discoverActivities.ts toggleInterest).
    const { error } = await ctx.db.from('discover_interests').insert({
      user_id: ctx.userId,
      activity_key: activityKey(a),
      title: a.title,
      category: a.category,
      description: a.description,
      location: a.location,
      starts_at: a.startsAt,
      ends_at: a.endsAt,
      price_label: a.priceLabel,
      url: a.url,
    });
    if (error && error.code !== '23505') throw new ToolError("Couldn't star it.");
    return `Starred "${a.title}". It shows on your Ping calendar. starred_key ${activityKey(a)}`;
  },
};

const unstarDiscover: Tool = {
  name: 'unstar_discover',
  title: 'Remove star',
  cls: 'write',
  description: 'Removes a Discover star. Use the starred_key from list_events, or an activity_id from search_discover.',
  inputSchema: {
    type: 'object',
    properties: { starred_key: { type: 'string' }, activity_id: { type: 'string' } },
  },
  async run(ctx, args) {
    let key = str(args.starred_key);
    const id = str(args.activity_id);
    if (!key && id) {
      if (id.startsWith('ping-')) {
        const { data: e } = await ctx.db.from('events').select('title, event_date').eq('id', id.slice(5)).maybeSingle();
        if (e) key = activityKey({ title: e.title, startsAt: e.event_date });
      } else if (UUID.test(id)) {
        const { data: r } = await ctx.db.from('activities').select('title, starts_at').eq('id', id).maybeSingle();
        if (r) key = activityKey({ title: r.title, startsAt: r.starts_at });
      }
    }
    if (!key) throw new ToolError('Give the starred_key from list_events.');
    const { data, error } = await ctx.db
      .from('discover_interests')
      .delete()
      .eq('user_id', ctx.userId)
      .eq('activity_key', key)
      .select('title');
    if (error) throw new ToolError("Couldn't remove the star.");
    if (!data || data.length === 0) return "That wasn't starred.";
    return `Removed the star from "${data[0].title}".`;
  },
};

// ---------- reminders ----------

const setReminder: Tool = {
  name: 'set_reminder',
  title: 'Remind me',
  cls: 'write',
  description:
    "Sets or turns off the person's own reminder for an event they're on: 30 minutes, 1 hour or 1 day before. It arrives as a Ping notification on their phone. Only the person is reminded - guests aren't told.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      remind: { type: 'string', enum: Object.keys(REMINDER_CHOICES), description: 'How long before it starts, or off.' },
      time_zone: TZ_PROP,
    },
    required: ['event_id', 'remind'],
  },
  async run(ctx, args) {
    const key = String(args.remind);
    if (!(key in REMINDER_CHOICES)) throw new ToolError(`remind must be one of: ${Object.keys(REMINDER_CHOICES).join(', ')}.`);
    const minutes = REMINDER_CHOICES[key];
    const { event, myInvitee } = await loadEvent(ctx, args.event_id);
    if (!myInvitee) throw new ToolError("You're not on this event, so there's nothing to remind you about.");
    const tz = await zoneFor(ctx, args.time_zone);
    const start = new Date(event.event_date).getTime();
    if (minutes != null) {
      if (start <= Date.now()) throw new ToolError(`"${event.title}" has already started.`);
      if (start - minutes * 60000 <= Date.now()) {
        const fits = Object.entries(REMINDER_CHOICES)
          .filter(([, m]) => m != null && start - m * 60000 > Date.now())
          .map(([k]) => k);
        throw new ToolError(
          `"${event.title}" starts ${whenLabel(event, tz)}, which is sooner than ${reminderWords(minutes)}.${fits.length ? ` Choices that still work: ${fits.join(', ')}.` : ''}`
        );
      }
    }
    // The event-reminders function sends it (supabase/ai_reminders.sql).
    const { error } = await ctx.db
      .from('invitees')
      .update({ reminder_minutes_before: minutes, reminder_push: minutes != null, reminder_pushed_for: null })
      .eq('id', myInvitee.id);
    if (error) throw new ToolError("Couldn't save the reminder.");
    // A reminder set earlier in the app left a not-yet-due bell entry; drop
    // it so the bell doesn't show two.
    await ctx.db
      .from('notifications')
      .delete()
      .eq('recipient_id', ctx.userId)
      .eq('event_id', event.id)
      .eq('type', 'event_reminder')
      .gt('created_at', new Date().toISOString());
    const setInApp = myInvitee.reminder_minutes_before != null && !myInvitee.reminder_push;
    const phoneNote = setInApp
      ? ` A ${reminderWords(myInvitee.reminder_minutes_before)} reminder set earlier in the Ping app may still go off on that phone - change it in the app if it isn't wanted.`
      : '';
    return minutes == null
      ? `Reminder for "${event.title}" turned off.${phoneNote}`
      : `You'll get a Ping notification ${reminderWords(minutes)} "${event.title}" (${whenLabel(event, tz)}).${phoneNote}`;
  },
};

// ---------- more event details ----------

const setCoHost: Tool = {
  name: 'set_cohost',
  title: 'Co-host',
  cls: 'sensitive',
  description:
    "Adds or removes a co-host on an event the person hosts. A co-host can edit the event and invite people, same as the host. They need the Ping app. Same as the app, they aren't sent a notification.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      person: { type: 'string', description: 'Name or person_id from list_people (or a co-host name from get_event, to remove).' },
      remove: { type: 'boolean', description: 'true removes them as co-host. Default false.' },
    },
    required: ['event_id', 'person'],
  },
  async run(ctx, args) {
    const { event, hostIds, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'change co-hosts');
    const who = str(args.person) ?? '';
    if (bool(args.remove, false)) {
      const coIds = hostIds.filter((id) => id !== event.host_id);
      if (coIds.length === 0) return `"${event.title}" has no co-hosts.`;
      const { data: profiles } = await ctx.db.from('profiles').select('id, full_name, email').in('id', coIds);
      // deno-lint-ignore no-explicit-any
      const named: { id: string; name: string }[] = (profiles || []).map((p: any) => ({ id: p.id as string, name: displayName(p) }));
      // A person_id from list_people points at a contact; use its account.
      const contact = UUID.test(who) ? (await myContacts(ctx)).find((c) => c.id === who) : undefined;
      const target = contact?.linked_user_id ? named.find((n) => n.id === contact.linked_user_id) : pickByName(named, who, 'co-host');
      if (!target) throw new ToolError(`${contact?.name ?? who} isn't a co-host on "${event.title}".`);
      const { error } = await ctx.db.from('event_hosts').delete().eq('event_id', event.id).eq('user_id', target.id);
      if (error) throw new ToolError("Couldn't remove that co-host.");
      return `${target.name} is no longer a co-host on "${event.title}". They're still on the guest list.`;
    }
    const contact = pickByName(await myContacts(ctx), who, 'person');
    const healed = await healContactLink(ctx.db, contact);
    if (!healed.linked_user_id) throw new ToolError(`${contact.name} needs the Ping app before they can be a co-host.`);
    if (healed.linked_user_id === event.host_id) throw new ToolError(`${contact.name} is already the host.`);
    if (hostIds.includes(healed.linked_user_id)) return `${contact.name} is already a co-host on "${event.title}".`;
    const { error } = await ctx.db.from('event_hosts').insert([{ event_id: event.id, user_id: healed.linked_user_id }]);
    if (error) throw new ToolError("Couldn't add that co-host.");
    // Like the host, a co-host needs a guest-list row to see the event.
    const { data: already } = await ctx.db
      .from('invitees')
      .select('id')
      .eq('event_id', event.id)
      .eq('user_id', healed.linked_user_id)
      .maybeSingle();
    if (!already) {
      const { error: invErr } = await ctx.db.from('invitees').insert([
        {
          event_id: event.id,
          contact_id: contact.id,
          user_id: healed.linked_user_id,
          rsvp_status: 'accepted',
          invited_via: 'app',
          responded_at: new Date().toISOString(),
        },
      ]);
      if (invErr) console.error('Error creating co-host invitee row:', invErr);
    }
    return `${contact.name} is now a co-host on "${event.title}".`;
  },
};

const makeRepeating: Tool = {
  name: 'make_repeating',
  title: 'Repeat',
  cls: 'write',
  description:
    "Makes an event the person hosts repeat - daily, weekly, monthly or yearly - by adding the later dates. Each date gets the same details, co-hosts, What to bring list and guest list (guests answer each date on their own; no new invites are sent). Give times or until. Ping makes at most 52 dates.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
      every: { type: 'number', description: 'Every N days/weeks/months/years. Default 1.' },
      times: { type: 'number', description: 'How many dates in all, counting this one.' },
      until: { type: 'string', description: 'Last possible date, YYYY-MM-DD.' },
      time_zone: TZ_PROP,
    },
    required: ['event_id', 'frequency'],
  },
  async run(ctx, args) {
    const { event } = await loadEvent(ctx, args.event_id);
    if (event.host_id !== ctx.userId) throw new ToolError('Only the main host can make an event repeat.');
    if (event.recurrence_id) throw new ToolError(`"${event.title}" already repeats. Change the repeat in the Ping app.`);
    const frequency = String(args.frequency);
    if (!['daily', 'weekly', 'monthly', 'yearly'].includes(frequency)) throw new ToolError('frequency must be daily, weekly, monthly or yearly.');
    const interval = Math.min(Math.max(int(args.every, 1), 1), 99);
    const times = typeof args.times === 'number' ? Math.floor(args.times) : null;
    if (!times && !str(args.until)) throw new ToolError('Say how many times (times) or until what date (until).');
    if (times !== null && times < 2) throw new ToolError('times counts this date too, so it needs to be 2 or more.');
    const tz = event.time_zone || (await zoneFor(ctx, args.time_zone));
    const untilEnd = str(args.until)
      ? new Date(parseWhen(str(args.until)!.slice(0, 10), tz, 'until').at.getTime() + 12 * 3600_000)
      : null;

    const start = new Date(event.event_date);
    const durationMs = event.end_date ? new Date(event.end_date).getTime() - start.getTime() : null;
    const p = partsIn(start, tz);
    let local: Local = { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute };
    const dates: Date[] = [];
    while (dates.length + 1 < MAX_GENERATED_OCCURRENCES) {
      if (times !== null && dates.length + 1 >= times) break;
      local = advanceLocal(local, frequency, interval, p.day);
      const at = instantFromLocal(local, tz);
      if (untilEnd && at >= untilEnd) break;
      dates.push(at);
    }
    if (dates.length === 0) throw new ToolError('No later dates fit before that end date.');

    // Everything copied onto each date (EditEventModal createFutureOccurrences).
    const [{ data: full }, { data: coHosts }, { data: items }, { data: guests }] = await Promise.all([
      ctx.db
        .from('events')
        .select('is_public, discoverable, discover_category, capacity, price_cents, image_url, image_url_full, group_id, comments_enabled')
        .eq('id', event.id)
        .single(),
      ctx.db.from('event_hosts').select('user_id').eq('event_id', event.id),
      ctx.db.from('items').select('name, quantity_needed, allow_custom').eq('event_id', event.id),
      ctx.db.from('invitees').select('contact_id, user_id, invited_via').eq('event_id', event.id),
    ]);
    const recurrenceId = crypto.randomUUID();
    const { error: anchorErr } = await ctx.db.from('events').update({ recurrence_id: recurrenceId }).eq('id', event.id);
    if (anchorErr) throw new ToolError("Couldn't make it repeat.");

    const baseStops = Array.isArray(event.stops) ? (event.stops as Stop[]) : [];
    const dayNumber = (d: Date) => {
      const q = partsIn(d, tz);
      return Date.UTC(q.year, q.month - 1, q.day) / 86400000;
    };
    // deno-lint-ignore no-explicit-any
    const guestRows = (guests || []).filter((g: any) => g.user_id !== ctx.userId);
    const failed: string[] = [];
    for (const at of dates) {
      const { data: row, error } = await ctx.db
        .from('events')
        .insert([
          {
            title: event.title,
            description: event.description,
            location: event.location ?? '',
            stops: shiftStops(baseStops, dayNumber(at) - dayNumber(start)),
            event_date: at.toISOString(),
            end_date: durationMs !== null ? new Date(at.getTime() + durationMs).toISOString() : null,
            time_zone: event.time_zone,
            is_all_day: event.is_all_day,
            status: event.status,
            host_id: ctx.userId,
            recurrence_id: recurrenceId,
            ...(full || {}),
          },
        ])
        .select('id')
        .single();
      if (error || !row) {
        console.error('Error creating repeat date:', error);
        failed.push(formatInZone(at.toISOString(), tz, true));
        continue;
      }
      await ctx.db.from('invitees').insert([
        { event_id: row.id, user_id: ctx.userId, rsvp_status: 'accepted', invited_via: 'app', responded_at: new Date().toISOString() },
      ]);
      // deno-lint-ignore no-explicit-any
      if (coHosts?.length) await ctx.db.from('event_hosts').insert(coHosts.map((c: any) => ({ event_id: row.id, user_id: c.user_id })));
      if (items?.length) {
        // deno-lint-ignore no-explicit-any
        await ctx.db.from('items').insert(items.map((it: any) => ({ ...it, event_id: row.id })));
      }
      if (guestRows.length) {
        await ctx.db.from('invitees').insert(
          // deno-lint-ignore no-explicit-any
          guestRows.map((g: any) => ({ event_id: row.id, contact_id: g.contact_id, user_id: g.user_id, rsvp_status: 'pending', invited_via: g.invited_via }))
        );
      }
    }
    const made = dates.length - failed.length;
    const last = dates[dates.length - 1];
    let out = `"${event.title}" now repeats ${interval > 1 ? `every ${interval} ${frequency.replace('ly', '').replace('dai', 'day')}s` : frequency}: ${made} more date${made === 1 ? '' : 's'}, through ${formatInZone(last.toISOString(), tz, true)}.`;
    if (guestRows.length) out += ' The guest list is on every date; guests answer each one.';
    if (failed.length) out += ` These dates didn't save: ${failed.join(', ')}.`;
    return out;
  },
};

const discoverListing: Tool = {
  name: 'discover_listing',
  title: 'List on Discover',
  cls: 'sensitive',
  description:
    "Lists an event the person hosts on Discover, where anyone nearby using Ping can see it and join, or takes it off. Discover covers the Utah (Wasatch Front) and Boise areas. Ticket prices are set in the Ping app.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      listed: { type: 'boolean', description: 'true lists it, false takes it off Discover.' },
      category: { type: 'string', enum: DISCOVER_CATEGORIES, description: 'Needed when listing. Default community.' },
      capacity: { type: 'number', description: 'Most people who can say going. Leave out for no limit.' },
    },
    required: ['event_id', 'listed'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'list it on Discover');
    if (event.price_cents && event.price_cents > 0) {
      throw new ToolError('This event sells tickets, so change its Discover listing in the Ping app.');
    }
    if (!bool(args.listed, true)) {
      const { error } = await ctx.db
        .from('events')
        .update({ discoverable: false, discover_category: null, capacity: null, price_cents: null })
        .eq('id', event.id);
      if (error) throw new ToolError("Couldn't take it off Discover.");
      return `"${event.title}" is off Discover. Everyone already going stays on the guest list.`;
    }
    if (event.status !== 'sent') throw new ToolError('Send the event from the app before listing it.');
    if (containsObjectionableContent(`${event.title} ${event.description ?? ''}`)) {
      throw new ToolError("This event's title or notes can't be listed on Discover. Change the wording first.");
    }
    const category = str(args.category) && DISCOVER_CATEGORIES.includes(str(args.category)!) ? str(args.category)! : 'community';
    const capacity = typeof args.capacity === 'number' && args.capacity > 0 ? Math.floor(args.capacity) : null;
    const { error } = await ctx.db
      .from('events')
      .update({ discoverable: true, is_public: true, discover_category: category, capacity })
      .eq('id', event.id);
    if (error) throw new ToolError(`Couldn't list it${error.message ? `: ${error.message}` : ''}.`);
    return `"${event.title}" is listed on Discover under ${category}${capacity ? `, up to ${capacity} going` : ''}. People nearby can find it and join.`;
  },
};

// ---------- guests and What to bring ----------

type Guest = { id: string; userId: string | null; contactId: string | null; name: string };
async function loadGuests(ctx: Ctx, eventId: string): Promise<Guest[]> {
  const { data } = await ctx.db
    .from('invitees')
    .select('id, user_id, contact_id, profiles(full_name, email), contacts(name)')
    .eq('event_id', eventId);
  // deno-lint-ignore no-explicit-any
  return (data || []).map((g: any) => ({
    id: g.id as string,
    userId: g.user_id as string | null,
    contactId: g.contact_id as string | null,
    name: (g.contacts?.name || displayName(g.profiles)) as string,
  }));
}

const removeGuest: Tool = {
  name: 'remove_guest',
  title: 'Remove guest',
  cls: 'sensitive',
  description:
    "Takes someone off the guest list of an event the person hosts, along with anything they signed up to bring. They aren't sent a notification.",
  inputSchema: {
    type: 'object',
    properties: { event_id: EVENT_ID_PROP, person: { type: 'string', description: 'Guest name from get_event, or a person_id.' } },
    required: ['event_id', 'person'],
  },
  async run(ctx, args) {
    const { event, hostIds, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'remove guests');
    const who = str(args.person) ?? '';
    const guests = (await loadGuests(ctx, event.id)).filter((g) => g.userId !== ctx.userId);
    const g = guests.find((x) => x.contactId === who) ?? pickByName(guests, who, 'guest');
    if (g.userId && hostIds.includes(g.userId)) {
      throw new ToolError(`${g.name} is a host. ${g.userId === event.host_id ? "The main host can't be removed." : 'Remove them as co-host first (set_cohost).'}`);
    }
    // Same cleanup as EventDetailContent handleRemoveInvitee.
    await ctx.db.from('item_claims').delete().eq('invitee_id', g.id);
    await ctx.db.from('items').update({ assigned_to: null }).eq('assigned_to', g.id);
    const { error } = await ctx.db.from('invitees').delete().eq('id', g.id);
    if (error) throw new ToolError(`Couldn't remove ${g.name}.`);
    return `Removed ${g.name} from "${event.title}".`;
  },
};

async function pickItem(ctx: Ctx, eventId: string, query: string) {
  const { data } = await ctx.db
    .from('items')
    .select('id, name, quantity_needed, allow_custom, item_claims(id, quantity)')
    .eq('event_id', eventId);
  // deno-lint-ignore no-explicit-any
  return pickByName((data || []) as any[], query, 'item');
}

const editBringItem: Tool = {
  name: 'edit_bring_item',
  title: 'Change What to bring item',
  cls: 'write',
  description:
    "Changes an item on What to bring for an event the person hosts: its name, how many are needed, or whether it's an open list where each guest writes in what they're bringing.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      item: { type: 'string', description: 'Item name or item_id from get_event.' },
      name: { type: 'string', description: 'New name.' },
      quantity: { type: 'number', description: 'How many are needed.' },
      open_list: { type: 'boolean', description: 'true: anyone can add what they bring. Only for items nobody has signed up for yet.' },
    },
    required: ['event_id', 'item'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'change What to bring');
    const item = await pickItem(ctx, event.id, str(args.item) ?? '');
    // deno-lint-ignore no-explicit-any
    const claims = (item.item_claims || []) as any[];
    const taken = claims.reduce((n: number, c: { quantity: number }) => n + c.quantity, 0);
    // deno-lint-ignore no-explicit-any
    const updates: Record<string, any> = {};
    if (str(args.name)) updates.name = str(args.name);
    if (typeof args.quantity === 'number') {
      const q = Math.max(Math.floor(args.quantity), 1);
      if (!item.allow_custom && q < taken) throw new ToolError(`${taken} "${item.name}" are already signed up for, so it can't go below ${taken}.`);
      updates.quantity_needed = q;
    }
    if (typeof args.open_list === 'boolean' && args.open_list !== item.allow_custom) {
      if (claims.length) throw new ToolError(`People already signed up for "${item.name}", so it can't switch between a count and an open list.`);
      updates.allow_custom = args.open_list;
    }
    if (Object.keys(updates).length === 0) return 'Nothing to change.';
    // .select() so a change the database refused (0 rows) isn't reported as saved.
    const { data: saved, error } = await ctx.db.from('items').update(updates).eq('id', item.id).select('id');
    if (error || !saved?.length) throw new ToolError("Couldn't change it.");
    const name = updates.name ?? item.name;
    const allowCustom = updates.allow_custom ?? item.allow_custom;
    return `Saved: "${name}"${allowCustom ? ' (open list, anyone can add)' : `, ${updates.quantity_needed ?? item.quantity_needed} needed`} on "${event.title}".`;
  },
};

const removeBringItem: Tool = {
  name: 'remove_bring_item',
  title: 'Remove What to bring item',
  cls: 'sensitive',
  description:
    "Removes an item from What to bring on an event the person hosts. Anyone signed up to bring it is taken off it (they aren't notified).",
  inputSchema: {
    type: 'object',
    properties: { event_id: EVENT_ID_PROP, item: { type: 'string', description: 'Item name or item_id from get_event.' } },
    required: ['event_id', 'item'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'change What to bring');
    const item = await pickItem(ctx, event.id, str(args.item) ?? '');
    await ctx.db.from('item_claims').delete().eq('item_id', item.id);
    const { error } = await ctx.db.from('items').delete().eq('id', item.id);
    if (error) throw new ToolError("Couldn't remove it.");
    const n = (item.item_claims || []).length;
    return `Removed "${item.name}" from "${event.title}".${n ? ` ${n} sign-up${n === 1 ? ' was' : 's were'} cleared.` : ''}`;
  },
};

// ---------- groups ----------

async function addGroupMembers(ctx: Ctx, groupId: string, people: string[], current: Set<string>) {
  const contacts = await myContacts(ctx);
  const added: string[] = [];
  const already: string[] = [];
  for (const p of people) {
    const c = pickByName(contacts, p, 'person');
    if (current.has(c.id)) {
      already.push(c.name);
      continue;
    }
    // Heal the account link first, same as app/groups/[id].tsx.
    const healed = await healContactLink(ctx.db, c);
    const { error } = await ctx.db.from('group_members').insert([{ group_id: groupId, contact_id: c.id, user_id: healed.linked_user_id || null }]);
    if (error) throw new ToolError(`Couldn't add ${c.name}.`);
    current.add(c.id);
    added.push(c.name);
  }
  return { added, already };
}

const createGroup: Tool = {
  name: 'create_group',
  title: 'New group',
  cls: 'write',
  description: 'Makes a new group from the person\'s people, so they can invite everyone in it at once. Nobody is notified.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      people: { type: 'array', items: { type: 'string' }, description: 'Names or person_ids from list_people.' },
    },
    required: ['name'],
  },
  async run(ctx, args) {
    const name = str(args.name);
    if (!name) throw new ToolError('The group needs a name.');
    // Check names before making anything, so a typo doesn't leave an empty group.
    const contacts = await myContacts(ctx);
    for (const p of strList(args.people)) pickByName(contacts, p, 'person');
    const { data: g, error } = await ctx.db.from('groups').insert([{ owner_id: ctx.userId, name }]).select('id').single();
    if (error || !g) throw new ToolError("Couldn't make the group.");
    const { added } = await addGroupMembers(ctx, g.id, strList(args.people), new Set());
    return `Made the group "${name}"${added.length ? ` with ${added.join(', ')}` : ' (empty)'}. group_id ${g.id}`;
  },
};

const editGroup: Tool = {
  name: 'edit_group',
  title: 'Change group',
  cls: 'write',
  description:
    "Changes a group the person owns: rename it, add or remove people, or share it (members who have Ping can then see it and invite the whole group too). Groups shared with the person can only be changed by their owner.",
  inputSchema: {
    type: 'object',
    properties: {
      group: { type: 'string', description: 'Group name or group_id from list_groups.' },
      new_name: { type: 'string' },
      add_people: { type: 'array', items: { type: 'string' } },
      remove_people: { type: 'array', items: { type: 'string' } },
      shared: { type: 'boolean' },
    },
    required: ['group'],
  },
  async run(ctx, args) {
    const groups = await ownedGroups(ctx);
    const g = pickByName(groups, str(args.group) ?? '', 'group of yours');
    const out: string[] = [];
    if (str(args.new_name)) {
      const { error } = await ctx.db.from('groups').update({ name: str(args.new_name) }).eq('id', g.id);
      if (error) throw new ToolError("Couldn't rename it.");
      out.push(`renamed to "${str(args.new_name)}"`);
    }
    if (typeof args.shared === 'boolean') {
      const { error } = await ctx.db.from('groups').update({ is_shared: args.shared }).eq('id', g.id);
      if (error) throw new ToolError("Couldn't change sharing.");
      out.push(args.shared ? 'shared with its members' : 'no longer shared');
    }
    const current = new Set(g.members.map((m) => m.contactId));
    const removed: string[] = [];
    for (const p of strList(args.remove_people)) {
      const m = pickByName(
        g.members.map((x) => ({ id: x.contactId, name: x.name })),
        p,
        `member of ${g.name}`
      );
      const { error } = await ctx.db.from('group_members').delete().eq('group_id', g.id).eq('contact_id', m.id);
      if (error) throw new ToolError(`Couldn't remove ${m.name}.`);
      current.delete(m.id);
      removed.push(m.name);
    }
    const { added, already } = await addGroupMembers(ctx, g.id, strList(args.add_people), current);
    if (added.length) out.push(`added ${added.join(', ')}`);
    if (removed.length) out.push(`removed ${removed.join(', ')}`);
    if (already.length) out.push(`${already.join(', ')} already in it`);
    return out.length ? `"${g.name}": ${out.join('; ')}.` : 'Nothing to change.';
  },
};

const deleteGroup: Tool = {
  name: 'delete_group',
  title: 'Delete group',
  cls: 'sensitive',
  description:
    "Deletes a group the person owns. The people stay in their contacts and on any events; only the group goes. This can't be undone - confirm first.",
  inputSchema: { type: 'object', properties: { group: { type: 'string' } }, required: ['group'] },
  async run(ctx, args) {
    const g = pickByName(await ownedGroups(ctx), str(args.group) ?? '', 'group of yours');
    const { error } = await ctx.db.from('groups').delete().eq('id', g.id);
    if (error) throw new ToolError("Couldn't delete it.");
    return `Deleted the group "${g.name}".`;
  },
};

// ---------- chat and notifications ----------

async function loadMyMessage(ctx: Ctx, rawId: unknown) {
  const id = str(rawId);
  if (!id || !UUID.test(id)) throw new ToolError('Give a message_id from get_event (only your own messages have one).');
  const { data } = await ctx.db.from('messages').select('id, event_id, sender_id, body, deleted_at').eq('id', id).maybeSingle();
  if (!data || data.sender_id !== ctx.userId) throw new ToolError('That message wasn\'t found, or it isn\'t yours.');
  if (data.deleted_at) throw new ToolError('That message was already deleted.');
  return data as { id: string; event_id: string; body: string };
}

const editMessage: Tool = {
  name: 'edit_message',
  title: 'Edit my message',
  cls: 'sensitive',
  description:
    "Changes the words of one of the person's own messages in an event chat. Everyone sees the new words, marked edited (nobody is notified). Show the person the new words first.",
  inputSchema: {
    type: 'object',
    properties: { message_id: { type: 'string' }, text: { type: 'string' } },
    required: ['message_id', 'text'],
  },
  async run(ctx, args) {
    const body = str(args.text);
    if (!body) throw new ToolError('The message is empty. Use delete_message to remove it.');
    if (body.length > 4000) throw new ToolError('That message is too long.');
    const m = await loadMyMessage(ctx, args.message_id);
    // The database stamps edited_at itself (supabase/message_edit_delete.sql).
    const { error } = await ctx.db.from('messages').update({ body }).eq('id', m.id);
    if (error) throw new ToolError("Couldn't save the edit.");
    if (await flagIfObjectionable(ctx.db, body, { userId: ctx.userId, contentType: 'message', contentId: m.id, eventId: m.event_id })) {
      await notify(ctx.db, ctx.push, [ADMIN_USER_ID], 'New report', 'Auto-flagged message content', { type: 'report' });
    }
    return 'Message edited.';
  },
};

const deleteMessage: Tool = {
  name: 'delete_message',
  title: 'Delete my message',
  cls: 'sensitive',
  description: 'Deletes one of the person\'s own messages in an event chat. It shows as "Message deleted" for everyone. Confirm first.',
  inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
  async run(ctx, args) {
    const m = await loadMyMessage(ctx, args.message_id);
    const { error } = await ctx.db.from('messages').update({ deleted_at: new Date().toISOString(), body: '' }).eq('id', m.id);
    if (error) throw new ToolError("Couldn't delete it.");
    return 'Message deleted.';
  },
};

const listNotifications: Tool = {
  name: 'list_notifications',
  title: 'My notifications',
  cls: 'read',
  description:
    "The person's latest Ping notifications - invites, RSVPs, chat messages, changes and reminders - newest first, with the event_id they're about.",
  inputSchema: {
    type: 'object',
    properties: {
      unread_only: { type: 'boolean', description: 'Default false.' },
      limit: { type: 'number', description: 'Default 20, max 50.' },
      time_zone: TZ_PROP,
    },
  },
  async run(ctx, args) {
    const tz = await zoneFor(ctx, args.time_zone);
    let q = ctx.db
      .from('notifications')
      .select('title, body, type, event_id, created_at, read_at')
      .eq('recipient_id', ctx.userId)
      // Reminders set in the app are saved ahead, dated when they're due.
      .lte('created_at', new Date().toISOString())
      .order('created_at', { ascending: false })
      .limit(Math.min(Math.max(int(args.limit, 20), 1), 50));
    if (bool(args.unread_only, false)) q = q.is('read_at', null);
    const { data, error } = await q;
    if (error) throw new ToolError("Couldn't load notifications.");
    if (!data || data.length === 0) return bool(args.unread_only, false) ? 'No unread notifications.' : 'No notifications yet.';
    // deno-lint-ignore no-explicit-any
    return (data as any[])
      .map(
        (n) =>
          `- ${n.read_at ? '' : '[new] '}${n.title}${n.body ? ` - ${n.body}` : ''} (${formatInZone(n.created_at, tz)})${n.event_id ? ` | event_id ${n.event_id}` : ''}`
      )
      .join('\n');
  },
};

// ---------- event photos (free stock photos) ----------
// Pixabay first (free to use, no credit needed; key in the PIXABAY_API_KEY
// secret - Pexels stopped issuing API keys in Nov 2026), then Openverse
// limited to public-domain/CC0 images, which need no credit either. Only
// photos looked up from these two by id are ever downloaded - never an
// arbitrary URL. Pixabay's API terms ask apps to keep their own copy rather
// than link to Pixabay's, which is what the library does.

// One photo choice. `id` is what the AI passes back: pixabay:123,
// openverse:<uuid>, or library:<uuid> for one Ping already saved.
type Photo = {
  id: string;
  source: 'pixabay' | 'openverse';
  sourceId: string;
  description: string;
  by: string;
  license: string;
  url: string; // where to download it (or the saved copy, for library photos)
  width: number | null;
  height: number | null;
  libraryId?: string;
};
const UA = { 'User-Agent': 'PingApp/1.1 (+https://pingmobileapp.github.io/Ping/ai.html)' };
const MAX_PHOTO_BYTES = 12 * 1024 * 1024;
// Bigger than this takes too long to shrink inside an edge function (about
// 2 seconds of CPU per request): 12 MP took ~2.9 s in testing.
const MAX_PHOTO_PIXELS = 6_000_000;
// Same longest edge as the app's event banner (lib/imageUpload.ts). One
// copy serves as both the banner and the tap-to-view photo.
const PHOTO_MAX_EDGE = 1600;
const PHOTO_JPEG_QUALITY = 75;

// deno-lint-ignore no-explicit-any
function fromPixabay(p: any): Photo | null {
  // largeImageURL is Pixabay's 1280px copy, the biggest a standard key gets.
  if (!p?.largeImageURL) return null;
  const tags = String(p.tags || '').split(',').map((t: string) => t.trim()).filter(Boolean);
  return {
    id: `pixabay:${p.id}`,
    source: 'pixabay',
    sourceId: String(p.id),
    description: tags.length ? tags.slice(0, 4).join(', ') : 'Photo',
    by: p.user || 'Pixabay',
    license: 'pixabay',
    url: p.largeImageURL,
    width: p.imageWidth ?? null,
    height: p.imageHeight ?? null,
  };
}

// deno-lint-ignore no-explicit-any
function fromOpenverse(r: any): Photo | null {
  if (!r?.url || (r.filesize && r.filesize > MAX_PHOTO_BYTES)) return null;
  // Too small to look sharp across the top of an event.
  if (r.width && r.width < 800) return null;
  let url = String(r.url);
  // StockSnap (and rawpixel) serve a ready-made ~1000px copy at `url`; the
  // width/height Openverse reports are the originals', so don't judge by them.
  const smallCopy = /^https:\/\/(cdn\.stocksnap\.io\/img-thumbs\/|images\.rawpixel\.com\/editor_1024\/)/.test(url);
  let pixels = !smallCopy && r.width && r.height ? r.width * r.height : 0;
  // Wikimedia serves ready-made smaller copies, but only at its standard
  // widths (1600 isn't one; 1920 is). Take that, then shrink to 1600.
  const WIKI_WIDTH = 1920;
  const wiki = url.match(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\/([0-9a-f])\/([0-9a-f]{2})\/([^/?#]+)$/);
  if (wiki && r.width > WIKI_WIDTH && /\.(jpe?g|png)$/i.test(wiki[3])) {
    url = `https://upload.wikimedia.org/wikipedia/commons/thumb/${wiki[1]}/${wiki[2]}/${wiki[3]}/${WIKI_WIDTH}px-${wiki[3]}`;
    pixels = WIKI_WIDTH * Math.round((WIKI_WIDTH * r.height) / r.width);
  }
  if (pixels > MAX_PHOTO_PIXELS) return null;
  return {
    id: `openverse:${r.id}`,
    source: 'openverse',
    sourceId: String(r.id),
    description: r.title || 'Photo',
    by: r.creator || r.source || 'Openverse',
    license: String(r.license),
    url,
    width: r.width ?? null,
    height: r.height ?? null,
  };
}

// ---- providers ----

const PIXABAY = 'https://pixabay.com/api/';

async function searchPixabay(query: string, count: number): Promise<Photo[]> {
  const key = Deno.env.get('PIXABAY_API_KEY');
  if (!key) return [];
  try {
    const res = await fetch(
      `${PIXABAY}?key=${encodeURIComponent(key)}&q=${encodeURIComponent(query.slice(0, 100))}&image_type=photo&orientation=horizontal&safesearch=true&min_width=1000&per_page=${Math.max(count, 3)}`,
      { headers: UA }
    );
    if (!res.ok) {
      console.error('Pixabay search failed:', res.status);
      return [];
    }
    return ((await res.json()).hits || []).map(fromPixabay).filter(Boolean).slice(0, count) as Photo[];
  } catch (err) {
    console.error('Pixabay search failed:', err);
    return [];
  }
}

// StockSnap: a CC0 stock-photo collection on Openverse whose photos look
// like event covers. The rest of Openverse is mostly museum, archive and
// government photos, so those only fill in when StockSnap has too few.
// (rawpixel was tried 2026-11-07 but doesn't serve automated downloads.)
const OPENVERSE_STOCK_SOURCES = 'stocksnap';

async function openversePage(query: string, size: number, sources: string | null): Promise<Photo[]> {
  try {
    const res = await fetch(
      `https://api.openverse.org/v1/images/?q=${encodeURIComponent(query)}&license=cc0,pdm&aspect_ratio=wide&mature=false&page_size=${size}${sources ? `&source=${sources}` : ''}`,
      { headers: UA }
    );
    if (!res.ok) {
      console.error('Openverse search failed:', res.status);
      return [];
    }
    return ((await res.json()).results || []).map(fromOpenverse).filter(Boolean) as Photo[];
  } catch (err) {
    console.error('Openverse search failed:', err);
    return [];
  }
}

async function searchOpenverse(query: string, count: number): Promise<Photo[]> {
  const size = Math.min(count * 3, 20);
  const stock = await openversePage(query, size, OPENVERSE_STOCK_SOURCES);
  if (stock.length >= count) return stock.slice(0, count);
  const seen = new Set(stock.map((p) => p.id));
  const rest = (await openversePage(query, size, null)).filter((p) => !seen.has(p.id));
  return [...stock, ...rest].slice(0, count);
}

// Pixabay first, Openverse when Pixabay has nothing (or no key is set).
async function searchProviders(query: string, count: number): Promise<Photo[]> {
  const pixabay = await searchPixabay(query, count);
  return pixabay.length ? pixabay : await searchOpenverse(query, count);
}

async function providerPhotoById(source: string, raw: string): Promise<Photo | null> {
  if (source === 'pixabay' && /^\d+$/.test(raw)) {
    const key = Deno.env.get('PIXABAY_API_KEY');
    if (!key) return null;
    const res = await fetch(`${PIXABAY}?key=${encodeURIComponent(key)}&id=${raw}`, { headers: UA });
    if (!res.ok) return null;
    return fromPixabay(((await res.json()).hits || [])[0]);
  }
  if (source === 'openverse' && UUID.test(raw)) {
    const res = await fetch(`https://api.openverse.org/v1/images/${raw}/`, { headers: UA });
    if (!res.ok) return null;
    const r = await res.json();
    if (!['cc0', 'pdm'].includes(r.license)) return null;
    return fromOpenverse(r);
  }
  return null;
}

// ---- Ping's shared library (supabase/photo_library.sql) ----
// Read and written with ctx.library (service role): people can't add rows
// themselves, so nobody can slip an arbitrary picture into the gallery.

type LibraryRow = {
  id: string;
  source: 'pixabay' | 'openverse';
  source_id: string;
  description: string;
  search_terms: string;
  image_url: string;
  width: number | null;
  height: number | null;
  license: string;
  creator: string | null;
  hidden: boolean;
};
const LIBRARY_COLUMNS = 'id, source, source_id, description, search_terms, image_url, width, height, license, creator, hidden';

const fromLibrary = (r: LibraryRow): Photo => ({
  id: `library:${r.id}`,
  source: r.source,
  sourceId: r.source_id,
  description: r.description || 'Photo',
  by: r.creator || (r.source === 'pixabay' ? 'Pixabay' : 'Openverse'),
  license: r.license,
  url: r.image_url,
  width: r.width,
  height: r.height,
  libraryId: r.id,
});

const searchWords = (q: string) =>
  Array.from(new Set(q.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2))).slice(0, 5);

// Saved photos whose description or past searches contain every word.
async function searchLibrary(ctx: Ctx, query: string, count: number): Promise<Photo[]> {
  const words = searchWords(query);
  if (words.length === 0) return [];
  let q = ctx.library.from('photo_library').select(LIBRARY_COLUMNS).eq('hidden', false);
  for (const w of words) q = q.or(`search_terms.ilike.%${w}%,description.ilike.%${w}%`);
  const { data, error } = await q.order('use_count', { ascending: false }).limit(count);
  if (error) {
    console.error('Photo library search failed:', error);
    return [];
  }
  return ((data || []) as LibraryRow[]).map(fromLibrary);
}

async function libraryRowFor(ctx: Ctx, source: string, sourceId: string): Promise<LibraryRow | null> {
  const { data } = await ctx.library.from('photo_library').select(LIBRARY_COLUMNS).eq('source', source).eq('source_id', sourceId).maybeSingle();
  return (data as LibraryRow | null) ?? null;
}

// Downloads the photo, shrinks it to PHOTO_MAX_EDGE on its longest side
// and re-saves it as a JPEG, then keeps it once in the library/ folder of
// the event-images bucket (not under a person's folder, so it outlives any
// one account). Returns the existing row when it was saved before.
async function saveToLibrary(ctx: Ctx, photo: Photo, searchedFor: string): Promise<{ row: LibraryRow; kb: number | null }> {
  const existing = await libraryRowFor(ctx, photo.source, photo.sourceId);
  if (existing) return { row: existing, kb: null };
  const res = await fetch(photo.url, { headers: UA, redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) throw new ToolError("Couldn't download that photo. Try another one.");
  const original = new Uint8Array(await res.arrayBuffer());
  if (original.byteLength > MAX_PHOTO_BYTES) throw new ToolError('That photo is too big. Try another one.');
  const { jpeg, width, height } = await compressPhoto(original);
  const path = `library/${photo.source}-${photo.sourceId.replace(/[^a-zA-Z0-9-]/g, '')}.jpg`;
  const { error: upErr } = await ctx.library.storage.from('event-images').upload(path, jpeg, { contentType: 'image/jpeg', upsert: true });
  if (upErr) throw new ToolError("Couldn't save the photo.");
  const publicUrl = ctx.library.storage.from('event-images').getPublicUrl(path).data.publicUrl;
  const kb = Math.round(jpeg.byteLength / 1024);
  const { data, error } = await ctx.library
    .from('photo_library')
    .upsert(
      {
        source: photo.source,
        source_id: photo.sourceId,
        description: photo.description.slice(0, 300),
        search_terms: searchWords(searchedFor).join(' '),
        image_url: publicUrl,
        width,
        height,
        kb,
        license: photo.license,
        creator: photo.by.slice(0, 200),
        // Only public-domain photos are listed in the app's Gallery (Pixabay's
    // license rules out a browsable collection of its photos).
        in_gallery: photo.source === 'openverse' && ['cc0', 'pdm'].includes(photo.license),
      },
      { onConflict: 'source,source_id' }
    )
    .select(LIBRARY_COLUMNS)
    .single();
  if (error || !data) throw new ToolError("Couldn't save the photo.");
  return { row: data as LibraryRow, kb };
}

// Each use teaches the library another way people describe the photo, so
// the next search for those words finds it without a download.
async function noteLibraryUse(ctx: Ctx, row: LibraryRow, searchedFor: string) {
  const terms = new Set(row.search_terms.split(' ').filter(Boolean));
  for (const w of searchWords(searchedFor)) terms.add(w);
  const { error } = await ctx.library.rpc('note_photo_use', { p_id: row.id, p_terms: Array.from(terms).slice(0, 40).join(' ') });
  if (error) console.error('Error noting photo use:', error);
}

export async function compressPhoto(bytes: Uint8Array): Promise<{ jpeg: Uint8Array; width: number; height: number }> {
  let img: Image;
  try {
    const decoded = await decodeImage(bytes, true);
    if (!(decoded instanceof Image)) throw new Error('not a still image');
    img = decoded;
  } catch {
    throw new ToolError("That photo's file type can't be used. Try another one.");
  }
  if (img.width * img.height > MAX_PHOTO_PIXELS) throw new ToolError('That photo is too big. Try another one.');
  const original = { width: img.width, height: img.height };
  const shrunk = Math.max(img.width, img.height) > PHOTO_MAX_EDGE;
  if (shrunk) {
    if (img.width >= img.height) img.resize(PHOTO_MAX_EDGE, Image.RESIZE_AUTO);
    else img.resize(Image.RESIZE_AUTO, PHOTO_MAX_EDGE);
  }
  const jpeg = await img.encodeJPEG(PHOTO_JPEG_QUALITY);
  // An already well-compressed JPEG that's small enough can come out bigger
  // when re-saved; keep the smaller. Never keep an original over 1600px.
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (!shrunk && isJpeg && bytes.byteLength <= jpeg.byteLength) return { jpeg: bytes, ...original };
  return { jpeg, width: img.width, height: img.height };
}

const findEventPhotos: Tool = {
  name: 'find_event_photos',
  title: 'Find photos',
  cls: 'read',
  description:
    'Finds free photos for an event: ones already saved in Ping first, then Pixabay, then public-domain photos on Openverse. Search for what the event is about, like "backyard barbecue" or "mountain bike trail", not its exact title. Returns photo_ids for set_event_photo.',
  inputSchema: {
    type: 'object',
    properties: { search: { type: 'string', description: 'A few plain words describing the scene.' } },
    required: ['search'],
  },
  async run(ctx, args) {
    const q = str(args.search);
    if (!q) throw new ToolError('Say what to search for.');
    const saved = await searchLibrary(ctx, q, 3);
    const savedKeys = new Set(saved.map((p) => `${p.source}:${p.sourceId}`));
    const fresh = (await searchProviders(q, 6)).filter((p) => !savedKeys.has(p.id)).slice(0, 6 - saved.length);
    const photos = [...saved, ...fresh];
    if (photos.length === 0) return `No free photos found for "${q}". Try simpler words.`;
    return photos
      .map((p) => `- ${p.description} - by ${p.by}${p.libraryId ? ' (already in Ping)' : ''} | preview ${p.url} | photo_id ${p.id}`)
      .join('\n');
  },
};

const setEventPhoto: Tool = {
  name: 'set_event_photo',
  title: 'Event photo',
  cls: 'write',
  description:
    "Puts a free photo on an event the person hosts (shown at the top of the event), or removes the photo. Pass a photo_id from find_event_photos, or a search and the best match is used. It replaces any photo already there.",
  inputSchema: {
    type: 'object',
    properties: {
      event_id: EVENT_ID_PROP,
      photo_id: { type: 'string', description: 'From find_event_photos.' },
      search: { type: 'string', description: 'What it shows, in a few words. Needed when there is no photo_id; also helps others find the photo later.' },
      remove: { type: 'boolean', description: 'true takes the photo off the event.' },
    },
    required: ['event_id'],
  },
  async run(ctx, args) {
    const { event, isHost } = await loadEvent(ctx, args.event_id);
    requireHost(isHost, 'change the photo');
    if (bool(args.remove, false)) {
      const { error } = await ctx.db.from('events').update({ image_url: null, image_url_full: null }).eq('id', event.id);
      if (error) throw new ToolError("Couldn't remove the photo.");
      return `Removed the photo from "${event.title}".`;
    }
    const searchedFor = str(args.search) ?? event.title;
    let row: LibraryRow | null = null;
    let kb: number | null = null;
    const id = str(args.photo_id);
    if (id) {
      const [source, raw = ''] = id.split(':');
      if (source === 'library') {
        if (!UUID.test(raw)) throw new ToolError('That photo_id is not one find_event_photos gave.');
        const { data } = await ctx.library.from('photo_library').select(LIBRARY_COLUMNS).eq('id', raw).maybeSingle();
        row = (data as LibraryRow | null) ?? null;
      } else {
        row = await libraryRowFor(ctx, source, raw);
        if (!row) {
          const photo = await providerPhotoById(source, raw);
          if (photo) ({ row, kb } = await saveToLibrary(ctx, photo, searchedFor));
        }
      }
      if (!row || row.hidden) throw new ToolError('That photo is no longer available. Search again with find_event_photos.');
    } else {
      const saved = (await searchLibrary(ctx, searchedFor, 1))[0];
      if (saved?.libraryId) {
        row = await libraryRowFor(ctx, saved.source, saved.sourceId);
      } else {
        const photo = (await searchProviders(searchedFor, 1))[0];
        if (!photo) throw new ToolError(`No free photos found for "${searchedFor}". Try find_event_photos with simpler words.`);
        ({ row, kb } = await saveToLibrary(ctx, photo, searchedFor));
      }
      if (!row) throw new ToolError('That photo is no longer available. Search again.');
    }
    const { error } = await ctx.db.from('events').update({ image_url: row.image_url, image_url_full: row.image_url }).eq('id', event.id);
    if (error) throw new ToolError("Couldn't put the photo on the event.");
    await noteLibraryUse(ctx, row, searchedFor);
    const how = kb != null ? `saved to Ping at ${kb} KB` : 'reused from Ping, nothing new stored';
    return `Added a photo to "${event.title}": ${row.description || 'Photo'} (by ${row.creator || row.source}; ${how}).`;
  },
};

// Admin only: grows the app's Gallery with public-domain photos for a
// subject, without putting them on any event. A few per call, to stay
// inside the function's CPU time.
const addGalleryPhotos: Tool = {
  name: 'add_gallery_photos',
  title: 'Add to Gallery (admin)',
  cls: 'write',
  adminOnly: true,
  description:
    "Admin only: adds up to 4 public-domain photos for a subject (like \"birthday party\") to the Gallery people pick event photos from in the app. Skips ones already saved.",
  inputSchema: {
    type: 'object',
    properties: { search: { type: 'string' }, count: { type: 'number', description: '1-4, default 3.' } },
    required: ['search'],
  },
  async run(ctx, args) {
    if (ctx.userId !== ADMIN_USER_ID) throw new ToolError('Only the Ping admin can do that.');
    const q = str(args.search);
    if (!q) throw new ToolError('Say what to search for.');
    const want = Math.min(Math.max(int(args.count, 3), 1), 4);
    const added: string[] = [];
    let skipped = 0;
    // Stock collections only: the Gallery is browsed, so archive and
    // museum photos stay out of it.
    for (const photo of await openversePage(q, 20, OPENVERSE_STOCK_SOURCES)) {
      if (added.length >= want) break;
      if (await libraryRowFor(ctx, photo.source, photo.sourceId)) {
        skipped++;
        continue;
      }
      try {
        const { kb } = await saveToLibrary(ctx, photo, q);
        added.push(`${photo.description} (${kb} KB)`);
      } catch (err) {
        console.error('Gallery add failed:', err);
      }
    }
    if (added.length === 0) return `Nothing new added for "${q}"${skipped ? ` (${skipped} already saved)` : ''}.`;
    return `Added to the Gallery for "${q}": ${added.join('; ')}.`;
  },
};

export const TOOLS: Tool[] = [
  listEvents,
  getEvent,
  listGroups,
  listPeople,
  searchDiscover,
  createEvent,
  editEvent,
  cancelEvent,
  invitePeople,
  rsvp,
  addBringItem,
  claimBringItem,
  postMessage,
  starDiscover,
  unstarDiscover,
  setReminder,
  setCoHost,
  makeRepeating,
  discoverListing,
  removeGuest,
  editBringItem,
  removeBringItem,
  createGroup,
  editGroup,
  deleteGroup,
  editMessage,
  deleteMessage,
  listNotifications,
  findEventPhotos,
  setEventPhoto,
  addGalleryPhotos,
];

const DESTRUCTIVE = ['cancel_event', 'remove_guest', 'remove_bring_item', 'delete_group', 'delete_message'];
const IDEMPOTENT = ['set_event_photo', 'star_discover', 'unstar_discover', 'claim_bring_item', 'set_reminder', 'discover_listing', 'edit_bring_item'];

// MCP tool annotations. Muse's portal fields for these are "coming soon",
// so the class is also written at the start of each description.
export function toolListing(t: Tool) {
  const label = t.cls === 'read' ? 'Read' : t.cls === 'write' ? 'Write' : 'Sensitive write - ask the person first';
  return {
    name: t.name,
    title: t.title,
    description: `[${label}] ${t.description}`,
    inputSchema: t.inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: t.cls === 'read',
      destructiveHint: DESTRUCTIVE.includes(t.name),
      idempotentHint: t.cls === 'read' || IDEMPOTENT.includes(t.name),
      // Sensitive writes reach other people (notifications, chat).
      openWorldHint: t.cls === 'sensitive',
    },
  };
}
