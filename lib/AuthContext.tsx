import React, { createContext, useContext, useEffect, useState } from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import { registerForPushNotifications } from './pushNotifications';
import NamePrompt from '../components/NamePrompt';

// New profile rows start with no full_name. Backfill it once from a real
// name signal (Google's profile name) if we have one. Deliberately does
// NOT fall back to guessing from the email address - a guessed name
// saved here would take priority over displayName()'s own nicer
// formatting everywhere it's shown, permanently baking in a bad guess.
// Users can also set an explicit name from Settings.
async function ensureProfileName(session: Session) {
  const userId = session.user.id;
  const name = session.user.user_metadata?.full_name || session.user.user_metadata?.name;
  if (!name) return;

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle();

  if (error || !profile || profile.full_name) return;

  await supabase.from('profiles').update({ full_name: name }).eq('id', userId);
}

type AuthContextType = {
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextType>({
  session: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
      if (session) {
        ensureProfileName(session);
        registerForPushNotifications(session.user.id);
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        ensureProfileName(session);
        registerForPushNotifications(session.user.id);
      }
    });

    return () => {
      listener.subscription.unsubscribe();
    };
  }, []);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, loading, signOut }}>
      {children}
      {session && (
        <NamePrompt
          key={session.user.id}
          userId={session.user.id}
          signUpName={session.user.user_metadata?.full_name || session.user.user_metadata?.name}
          accountCreatedAt={session.user.created_at}
        />
      )}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
