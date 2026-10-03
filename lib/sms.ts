const JOIN_LINK_BASE = 'https://pingmobileapp.github.io/Ping/invite.html';

export function buildInviteLink(inviteeId: string) {
  return `${JOIN_LINK_BASE}?i=${inviteeId}`;
}

// Used by NonAppInviteQueue.tsx to fill in the text handed off to the
// host's own Messages app for invitees with no linked account. Most of
// these people don't have Ping yet, so the text spells out the one step
// that makes the invite show up for them: signing up with the phone number
// this was sent to (see lib/healInvites.ts) - the old text was just the
// event and a bare link, and invited family members couldn't work out how
// to see the invite (real report, 2026-10-01).
export function buildInviteMessage(
  eventTitle: string,
  eventDate: Date,
  location: string,
  inviteeId: string,
  isAllDay = false,
) {
  const dateLabel = eventDate.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  const when = isAllDay
    ? dateLabel
    : `${dateLabel} at ${eventDate.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const link = buildInviteLink(inviteeId);

  return [
    `You're invited to "${eventTitle}"! ${when}${location ? ` — ${location}` : ''}.`,
    '',
    `See the details and RSVP on Ping: ${link}`,
    '',
    'New to Ping? Download it and sign up with this phone number — your invite will be waiting for you.',
  ].join('\n');
}
