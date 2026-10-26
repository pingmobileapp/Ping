-- Cron-only edge functions (2026-10-26).
--
-- The pg_cron jobs called the refresh-* crawlers and item-reminders with
-- the publishable key, which ships inside the app, so anyone could trigger
-- them. Now every job also sends x-cron-secret, and the functions check it
-- (supabase/functions/_shared/cron.ts) through check_cron_secret(). The
-- secret is generated here and only ever lives in Vault - nobody needs to
-- see or copy it.

-- 1. The secret itself.
select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'cron_secret')
where not exists (select 1 from vault.secrets where name = 'cron_secret');

-- 2. The functions ask the database whether the header matches. Only the
--    service role (which the edge functions use) may call this.
create or replace function public.check_cron_secret(p_given text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from vault.decrypted_secrets
    where name = 'cron_secret' and decrypted_secret = p_given
  );
$$;
revoke execute on function public.check_cron_secret(text) from public, anon, authenticated;
grant execute on function public.check_cron_secret(text) to service_role;

-- 3. Add the header to every job that calls one of these functions.
do $$
declare
  j record;
begin
  for j in
    select jobid, command from cron.job
    where (command like '%/functions/v1/refresh-%' or command like '%/functions/v1/item-reminders%')
      and command not like '%x-cron-secret%'
  loop
    perform cron.alter_job(
      j.jobid,
      command := replace(
        j.command,
        '''Content-Type'', ''application/json''',
        '''Content-Type'', ''application/json'',
      ''x-cron-secret'', (select decrypted_secret from vault.decrypted_secrets where name = ''cron_secret'')'
      )
    );
  end loop;
end $$;
