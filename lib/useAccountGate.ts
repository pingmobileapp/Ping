import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase';

// Backs the root-level gate in app/_layout.tsx - unlike the old phone-gate
// (deleted; Apple rejected requiring phone number just to use the app),
// a terms-of-use acceptance gate is exactly what Apple's Guideline 1.2
// review asked for, so this one really is meant to block entry until
// resolved. banned_at reuses the same gate for a suspended account
// (see app/admin.tsx) rather than a second screen.
export type AccountGateState = 'loading' | 'needs_terms' | 'banned' | 'clear';

export function useAccountGate(userId?: string | null) {
  const [state, setState] = useState<AccountGateState>('loading');

  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase
      .from('profiles')
      .select('accepted_terms_at, banned_at')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      console.error('Error fetching account gate status:', error);
      return;
    }
    if (data?.banned_at) setState('banned');
    else if (!data?.accepted_terms_at) setState('needs_terms');
    else setState('clear');
  }, [userId]);

  useEffect(() => {
    setState('loading');
    refresh();
  }, [refresh]);

  return { state, refresh };
}
