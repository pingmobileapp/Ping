import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';

// Stripe's account_links only accepts http(s) refresh_url/return_url - it
// rejects a custom app scheme outright ("Not a valid URL"). This is the
// https bridge stripe-connect-onboarding points Stripe at instead: Stripe's
// in-app browser (ASWebAuthenticationSession via expo-web-browser) lands
// here, and this page immediately hands off to the app's own pingapp://
// scheme, which the OS intercepts and expo-web-browser's
// openAuthSessionAsync is already watching for.
//
// `to` is only ever produced by stripe-connect-onboarding itself (never
// user-supplied), but this endpoint has no auth - Stripe hits it directly -
// so the scheme is still checked to keep it from being usable as an open
// redirect to an arbitrary URL.
serve((req) => {
  const to = new URL(req.url).searchParams.get('to') || '';
  const safe = to.startsWith('pingapp://');
  const target = safe ? to : 'pingapp://stripe/return';

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${target}">
<script>location.replace(${JSON.stringify(target)});</script>
</head><body>Returning to Ping&hellip;</body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html' } });
});
