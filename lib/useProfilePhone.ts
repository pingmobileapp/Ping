import { useCallback, useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '../supabase';

const dismissedKey = (userId: string) => `ping.profilePromptDismissed.${userId}`;

// Contact-linking (see lib/phone.ts) depends on profiles.phone - worth
// asking for, but never blocking. Apple rejected an earlier build
// (guideline 5.1.1(v)) for gating app entry on phone number, so this only
// drives a dismissible Home-screen banner (see app/(tabs)/index.tsx),
// shown at most once per account per device regardless of whether the
// user adds it or dismisses the banner.
export function useProfilePhone(userId?: string | null) {
  const [phone, setPhone] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const [{ data, error }, dismissedValue] = await Promise.all([
      supabase.from('profiles').select('phone').eq('id', userId).maybeSingle(),
      AsyncStorage.getItem(dismissedKey(userId)),
    ]);
    if (error) console.error('Error fetching profile phone:', error);
    setPhone(data?.phone || null);
    setDismissed(dismissedValue === 'true');
  }, [userId]);

  useEffect(() => {
    setLoading(true);
    refresh().finally(() => setLoading(false));
  }, [refresh]);

  return { hasPhone: !!phone, shouldPrompt: !loading && !phone && !dismissed, loading, refresh };
}

export async function dismissProfilePrompt(userId: string): Promise<void> {
  await AsyncStorage.setItem(dismissedKey(userId), 'true');
}
