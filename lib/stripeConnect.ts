import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../supabase';
import { describeFunctionError } from './edgeFunctionError';

export type ConnectStatus = 'not_started' | 'incomplete' | 'pending' | 'ready';

export type ConnectAccountState = {
  status: ConnectStatus;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

const NOT_STARTED: ConnectAccountState = {
  status: 'not_started',
  chargesEnabled: false,
  payoutsEnabled: false,
  detailsSubmitted: false,
};

// Same custom-scheme redirect pattern as the Google OAuth flow in
// (auth)/login.tsx - only works in a standalone/dev-client build, not
// Expo Go (see that file's own comment).
const buildReturnUrl = () => AuthSession.makeRedirectUri({ scheme: 'pingapp', path: 'stripe/return' });

export async function fetchConnectStatus(): Promise<ConnectAccountState> {
  const { data, error } = await supabase.functions.invoke('stripe-connect-status');
  if (error) {
    console.error('Error fetching Stripe Connect status:', error);
    return NOT_STARTED;
  }
  return {
    status: data.status,
    chargesEnabled: !!data.charges_enabled,
    payoutsEnabled: !!data.payouts_enabled,
    detailsSubmitted: !!data.details_submitted,
  };
}

// Opens Stripe's hosted onboarding flow in an in-app browser and resolves
// once the host closes it (finished, abandoned, or just backed out) -
// callers should re-run fetchConnectStatus right after regardless of which
// of those it was, since that's the only way to know what's actually true.
export async function startConnectOnboarding(): Promise<{ opened: boolean; error?: string }> {
  const returnUrl = buildReturnUrl();
  const { data, error } = await supabase.functions.invoke('stripe-connect-onboarding', {
    body: { returnUrl },
  });
  if (error || !data?.url) {
    console.error('Error starting Stripe Connect onboarding:', error);
    return { opened: false, error: await describeFunctionError(error, 'Could not start onboarding.') };
  }

  await WebBrowser.openAuthSessionAsync(data.url, returnUrl);
  return { opened: true };
}
