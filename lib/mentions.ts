// @mentions in a Ping's message thread. A mention is plain text in the
// message ("@Hyrum") - no ids stored - matched back to guests by name when
// sending (who to alert) and when rendering (what to highlight).

export type MentionGuest = { userId: string; fullName: string; label: string };

// First name, unless two guests share it - then the full name.
export function withMentionLabels(guests: { userId: string; fullName: string }[]): MentionGuest[] {
  const firstNameCounts = new Map<string, number>();
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  for (const g of guests) firstNameCounts.set(first(g.fullName).toLowerCase(), (firstNameCounts.get(first(g.fullName).toLowerCase()) ?? 0) + 1);
  return guests.map((g) => {
    const f = first(g.fullName);
    return { ...g, label: (firstNameCounts.get(f.toLowerCase()) ?? 0) > 1 ? g.fullName.trim() : f };
  });
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// "@Label" as a whole word - "@Hyrum" matches in "@Hyrum, hi" but not
// "@Hyrums". Longest labels first so "@Ruby Jane" wins over "@Ruby".
const mentionPattern = (labels: string[]) => {
  const sorted = [...new Set(labels.filter(Boolean))].sort((a, b) => b.length - a.length);
  return sorted.length ? new RegExp(`(^|[^\\w])@(${sorted.map(escape).join('|')})(?![\\w'])`, 'gi') : null;
};

export function findMentionedUserIds(body: string, guests: MentionGuest[]): string[] {
  const pattern = mentionPattern(guests.map((g) => g.label));
  if (!pattern) return [];
  const hit = new Set([...body.matchAll(pattern)].map((m) => m[2].toLowerCase()));
  return guests.filter((g) => hit.has(g.label.toLowerCase())).map((g) => g.userId);
}

// The "@word" being typed right before the cursor, if any - drives the
// suggestion list. Null once there's a space right after the @.
export function activeMentionQuery(text: string, cursor: number): { start: number; query: string } | null {
  const before = text.slice(0, cursor);
  const m = before.match(/(^|\s)@([\w'-]*)$/);
  if (!m) return null;
  return { start: before.length - m[2].length - 1, query: m[2] };
}

export function splitMentions(body: string, labels: string[]): { text: string; mention: boolean }[] {
  const pattern = mentionPattern(labels);
  if (!pattern) return [{ text: body, mention: false }];
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const m of body.matchAll(pattern)) {
    // m[1] is the character before the @ (or empty at the start).
    const i = (m.index ?? 0) + m[1].length;
    if (i > last) parts.push({ text: body.slice(last, i), mention: false });
    parts.push({ text: `@${m[2]}`, mention: true });
    last = i + m[2].length + 1;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}

// Who a new Ping message alerts. An @mention always alerts that person, even
// if they declined or muted the thread. Otherwise: declined guests get
// nothing, muted guests get a silent row (something to catch up on without
// buzzing their phone), everyone else gets a normal alert.
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
