-- The time zone a Ping's times were entered in (an IANA name like
-- 'America/Phoenix'). event_date/end_date stay timestamptz, so the moment is
-- always exact; this only says which zone's clock the host meant, so Create/
-- Edit show and save the times in that zone and the event screen can say
-- "6:30 PM MST" to someone looking from another zone. Null on Pings made
-- before 1.1.12 (or by older app versions): treated as the viewer's own zone.
-- Added 2026-10-22 after a Ping typed in Utah for a trip to Arizona showed an
-- hour early once the phone switched zones (TestFlight 1.1.11).
alter table public.events add column if not exists time_zone text;
