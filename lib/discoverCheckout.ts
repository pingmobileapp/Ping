import * as AuthSession from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { supabase } from '../supabase';
import { describeFunctionError } from './edgeFunctionError';

// Opens Stripe's hosted Checkout page for a priced event and resolves once
// the buyer closes it (paid, abandoned, or backed out) - same
// custom-scheme redirect + in-app-browser pattern as
// stripeConnect.ts's startConnectOnboarding. discover-checkout does the
// real work server-side (capacity/host-readiness checks, computing the
// charge, creating the session); the actual "did this pay" fact only
// becomes true once stripe-webhook processes Stripe's confirmation, not
// when this browser closes - callers should refetch and expect a short
// delay before the RSVP shows as accepted.
export async function startEventCheckout(eventId: string): Promise<{ opened: boolean; error?: string }> {
  const returnUrl = AuthSession.makeRedirectUri({ scheme: 'pingapp', path: 'discover/checkout-return' });
  const { data, error } = await supabase.functions.invoke('discover-checkout', {
    body: { eventId, returnUrl },
  });
  if (error || !data?.url) {
    console.error('Error starting event checkout:', error);
    return { opened: false, error: await describeFunctionError(error, 'Could not start checkout.') };
  }

  await WebBrowser.openAuthSessionAsync(data.url, returnUrl);
  return { opened: true };
}
