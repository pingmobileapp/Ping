// Lightweight keyword filter for Apple's Guideline 1.2 "method for
// filtering objectionable content" requirement. Deliberately doesn't
// block a post on a match - a naive keyword list has real false
// positives, and blocking outright would break legitimate use. Instead a
// match still saves normally but also raises an auto_filter report (see
// callers), feeding the same admin queue a user report would.
const OBJECTIONABLE_TERMS = [
  'nigger',
  'nigga',
  'faggot',
  'retard',
  'cunt',
  'kike',
  'spic',
  'chink',
  'tranny',
  'rape',
  'kill yourself',
  'kys',
];

export function containsObjectionableContent(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return OBJECTIONABLE_TERMS.some((term) => normalized.includes(term));
}
