import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Only the pg_cron jobs may run the scheduled functions (the refresh-*
// crawlers and item-reminders). Those jobs used to authenticate with the
// publishable key, which ships inside the app - so anyone who unzipped the
// IPA could trigger a crawl (spending Anthropic credits) or re-send every
// item-reminder push, as often as they liked. The jobs now also send
// x-cron-secret, read from Vault, and check_cron_secret() compares it there
// (see supabase/cron_secret.sql), so the secret never leaves the database.
// Fails closed: no header, no secret in Vault, or a lookup error all get 403.
export async function rejectUnlessCron(req: Request): Promise<Response | null> {
  const given = req.headers.get('x-cron-secret');
  if (given) {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data, error } = await admin.rpc('check_cron_secret', { p_given: given });
    if (!error && data === true) return null;
  }
  return new Response(JSON.stringify({ error: 'Forbidden' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
