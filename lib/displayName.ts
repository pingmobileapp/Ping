import { useEffect, useState } from 'react';
import { supabase } from '../supabase';

type NamedProfile = { full_name?: string | null; email?: string | null } | null | undefined;

// Turns an email local-part like "pierson.willhite" into "Pierson Willhite"
// so it reads as a name instead of a stray fragment of an email address.
function formatEmailLocalPart(localPart: string): string {
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function displayName(profile: NamedProfile, fallback = 'Guest'): string {
  if (!profile) return fallback;
  if (profile.full_name) return profile.full_name;
  if (profile.email) return formatEmailLocalPart(profile.email.split('@')[0]) || fallback;
  return fallback;
}

// The signed-in person's name as other people should see it: their Ping
// profile name (Settings -> Name), not the name on the Apple/Google account
// they signed in with. Message notifications used to send the sign-in name,
// so a family member whose Google account is named for her business showed
// up as "Willhites (Griddle and Flame)" instead of "Melissa Willhite"
// (TestFlight feedback, build 113). Falls back to the sign-in name, then the
// email, only if the profile has no name yet.

export async function myDisplayName(
  user: { id: string; email?: string | null; user_metadata?: { full_name?: string; name?: string } } | null | undefined,
  fallback = 'Someone'
): Promise<string> {
  if (!user) return fallback;
  const { data } = await supabase.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  return displayName(
    { full_name: data?.full_name || user.user_metadata?.full_name || user.user_metadata?.name, email: user.email },
    fallback
  );
}

// Same as myDisplayName, for rendering.
export function useMyDisplayName(
  user: Parameters<typeof myDisplayName>[0],
  fallback = 'Guest'
): string {
  const [name, setName] = useState(() =>
    displayName({ full_name: user?.user_metadata?.full_name, email: user?.email }, fallback)
  );
  useEffect(() => {
    let live = true;
    myDisplayName(user, fallback).then((n) => live && setName(n));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);
  return name;
}
