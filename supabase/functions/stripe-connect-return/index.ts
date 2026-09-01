import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

// Stripe's account_links / Checkout Sessions only accept http(s)
// return/success/cancel URLs - they reject a custom app scheme outright
// ("Not a valid URL"). This is the https bridge stripe-connect-onboarding
// and discover-checkout point Stripe at instead: Stripe's in-app browser
// (ASWebAuthenticationSession via expo-web-browser's openAuthSessionAsync)
// lands here and gets handed straight back to the app's own pingapp://
// scheme via a real HTTP redirect.
//
// This used to serve an HTML page with a meta-refresh + <script>
// location.replace(...) instead of a 302. That looked fine in code but a
// live device test (Discover checkout, 2026-09-01) showed the actual
// symptom: Supabase's edge gateway force-overrides every function
// response's Content-Type to text/plain and attaches a locked-down
// Content-Security-Policy ("default-src 'none'; sandbox") regardless of
// what headers the function sets - confirmed by curling the deployed URL
// directly. With Content-Type: text/plain the browser never parses the
// body as HTML at all, so the user was just looking at raw markup with no
// redirect ever firing. A bodyless 302 sidesteps the whole problem: there's
// nothing for the gateway's content-sniffing to touch, and this is the
// same mechanism every standard OAuth callback already relies on for
// ASWebAuthenticationSession to detect the return URL.
//
// `to` is only ever produced by our own functions (never user-supplied),
// but this endpoint has no auth - Stripe hits it directly - so the scheme
// is still checked to keep it from being usable as an open redirect to an
// arbitrary URL.
serve((req) => {
  const to = new URL(req.url).searchParams.get('to') || '';
  const safe = to.startsWith('pingapp://');
  const target = safe ? to : 'pingapp://stripe/return';

  return new Response(null, { status: 302, headers: { Location: target } });
});
