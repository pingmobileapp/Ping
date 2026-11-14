import { supabase } from '../supabase';

// Every deep link into the app passes through here before expo-router tries
// to match it to a screen (https://docs.expo.dev/router/advanced/native-intent/).
//
// pingapp://auth/callback is the redirect Google sign-in comes back on (see
// app/(auth)/login.tsx). On iOS, ASWebAuthenticationSession hands that URL
// straight back to openAuthSessionAsync and the router never sees it. On
// Android the browser tab returns it to the app as an ordinary deep link, so
// the router ALSO tried to open it as a screen - there is none - and a
// brand-new Android user landed on "Unmatched Route" the moment they were
// signed in (Android friend, 2026-11-14). So the callback is never routed:
// a link that arrives while the app is running is dropped (login.tsx already
// handles it), and a cold start lands on Home.
//
// If Android killed the app while the browser tab was open, the
// openAuthSessionAsync promise that would have set the session is gone, so
// the tokens in the URL are picked up here instead.
function isAuthCallback(path: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:\/\/)?\/?auth\/callback(?:[/?#]|$)/i.test(path);
}

async function finishSignInFromUrl(url: string) {
  try {
    const params = new URLSearchParams(url.replace(/^[^?#]*[?#]/, '').replace('#', '&'));
    const access_token = params.get('access_token');
    const refresh_token = params.get('refresh_token');
    if (!access_token || !refresh_token) return;
    const { data } = await supabase.auth.getSession();
    // login.tsx usually got there first with the same tokens.
    if (data.session?.access_token === access_token) return;
    await supabase.auth.setSession({ access_token, refresh_token });
  } catch (err) {
    console.error('Error finishing sign-in from callback link:', err);
  }
}

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (isAuthCallback(path)) {
      finishSignInFromUrl(path);
      // An empty path tells the router not to navigate at all.
      return initial ? '/' : '';
    }
  } catch {
    // Fall through to normal routing.
  }
  return path;
}
