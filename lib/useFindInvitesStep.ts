import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';

const seenKey = (userId: string) => `ping.findInvitesSeen.${userId}`;

// Whether to show components/FindInvitesScreen right after the terms gate:
// only for an account with no phone number on file, and only once per
// account per device - Continue and Skip both mark it seen. Never blocks on
// errors: if the check fails, the step is just skipped.
export function useFindInvitesStep(userId: string | null | undefined, enabled: boolean) {
  const [state, setState] = useState<'loading' | 'show' | 'done'>('loading');

  useEffect(() => {
    if (!userId || !enabled) return;
    let cancelled = false;
    setState('loading');
    (async () => {
      try {
        const [seen, { data }] = await Promise.all([
          AsyncStorage.getItem(seenKey(userId)),
          supabase.from('profiles').select('phone').eq('id', userId).maybeSingle(),
        ]);
        if (!cancelled) setState(seen === 'true' || data?.phone ? 'done' : 'show');
      } catch (err) {
        console.error('Error checking find-invites step:', err);
        if (!cancelled) setState('done');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, enabled]);

  const finish = useCallback(() => {
    setState('done');
    if (userId) AsyncStorage.setItem(seenKey(userId), 'true').catch(() => {});
  }, [userId]);

  return { state, finish };
}
