// An AI app connected through Ping's AI connector (supabase/functions/mcp)
// holds a real access token for the person, marked with a `client_id` claim
// naming the AI app. Those tokens must never delete an account or move
// money, whatever the person chose on the consent page - only the Ping app
// itself can. Call after the token's signature has been checked (getUser).
export function isAiAppToken(authHeader: string | null): boolean {
  const token = authHeader?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return false;
  try {
    const part = token.split('.')[1];
    const claims = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=')));
    return typeof claims.client_id === 'string' && claims.client_id !== '';
  } catch {
    return false;
  }
}

export const aiAppRefusal = () =>
  new Response(JSON.stringify({ error: 'Open the Ping app to do this.' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
