// The AI connector's tools. Every query runs through `ctx.db`, a supabase
// client carrying the signed-in person's own token, so Row Level Security
// decides what they can see and change - exactly as in the app. Nothing here
// uses the service role.
//
// Words shown to people stay the app's: "New Event", "Invite People",
// "What to bring", "Discover". Never "create a Ping".

import {
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
    ctx.db.from('invitees').select('id, rsvp_status').eq('event_id', id).eq('user_id', ctx.userId).maybeSingle(),
  ]);
  // deno-lint-ignore no-explicit-any
  const hostIds = [event.host_id, ...(coHosts || []).map((h: any) => h.user_id)].filter(Boolean) as string[];
  return {
    event: event as EventRow,
    hostIds,
    isHost: hostIds.includes(ctx.userId),
    myInvitee: (mine as { id: string; rsvp_status: string } | null) ?? null,
  };
}

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
        .select('body, created_at, sender_id, profiles(full_name, email)')
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
        lines.push(`- ${[s.day, s.time, s.name || s.title, s.location || s.address].filter(Boolean).join(' · ')}`);
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
      lines.push(`- ${m.sender_id === ctx.userId ? 'You' : displayName(m.profiles)} (${formatInZone(m.created_at, tz)}): ${m.body}`);
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
    return lines.length ? lines.join('\n') : 'No groups yet. Groups are made in the Ping app.';
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
    "Changes an event the person hosts: title, time, place or notes. Guests who haven't declined are told it changed unless notify_guests is false. For a repeating event this changes just this one date.",
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
    if (str(args.start) || str(args.end) || typeof args.all_day === 'boolean') {
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
      // lib/stops.ts cleanStops: a stop the new dates no longer cover moves
      // onto the nearest day still in the event.
      const stops = Array.isArray(event.stops) ? (event.stops as { day?: string }[]) : [];
      if (stops.length) {
        const dayKey = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: tz });
        const first = dayKey(start.at);
        const last = end && dayKey(end) > first ? dayKey(end) : first;
        updates.stops = stops
          .filter((s) => typeof s.day === 'string')
          .map((s) => ({ ...s, day: s.day! < first ? first : s.day! > last ? last : s.day }))
          .sort((a, b) => (a.day! < b.day! ? -1 : a.day! > b.day! ? 1 : 0));
      }
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
    return `Saved. "${after.title}" is now ${whenLabel(after, tz)}${after.location ? ` at ${after.location}` : ''}.${told ? ` ${told} guest${told === 1 ? ' was' : 's were'} told.` : ''}`;
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
];

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
      destructiveHint: t.name === 'cancel_event',
      idempotentHint: t.cls === 'read' || ['star_discover', 'unstar_discover', 'claim_bring_item'].includes(t.name),
      // Sensitive writes reach other people (notifications, chat).
      openWorldHint: t.cls === 'sensitive',
    },
  };
}
