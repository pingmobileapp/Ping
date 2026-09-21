-- One row per background crawler run, so a run that quietly fails or gets cut
-- off can be diagnosed afterwards - edge function logs aren't readable from
-- the CLI. Written only by the crawler functions (service role); RLS is on
-- with no policy, so the app and signed-in users can't read or write it.
-- Run via `supabase db query --linked -f supabase/crawler_runs.sql`.

create table if not exists public.crawler_runs (
  id uuid primary key default gen_random_uuid(),
  function_name text not null,
  region text not null,
  -- 'running' (still going, or cut off before it could finish), 'finished',
  -- or 'failed'.
  status text not null default 'running',
  detail text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists crawler_runs_started_at_idx on public.crawler_runs (started_at desc);

alter table public.crawler_runs enable row level security;
