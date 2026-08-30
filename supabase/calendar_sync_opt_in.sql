-- iOS calendar permission belongs to the app+device pairing, not to
-- whichever Ping account happens to be signed in - once ANY account on a
-- device has granted it, getCalendarPermissionStatus() reads "granted" for
-- every other account that later signs in on that same device too. Home's
-- phone-calendar sync silently trusted that OS-level check alone, so a
-- brand-new account signing in on a family member's already-permitted
-- phone got the real device calendar pulled in immediately, with no
-- chance to consent as THAT account. This is the per-account opt-in that
-- now gates the sync in addition to (not instead of) the OS permission
-- itself - see app/(tabs)/index.tsx.

alter table public.profiles add column if not exists calendar_sync_enabled boolean not null default false;

-- Grandfather in every profile that already existed before this column did
-- - each one represents someone who was already using (and had already
-- implicitly consented to, by tapping the original one-time OS prompt)
-- phone-calendar sync under the old all-or-nothing model. Only accounts
-- created from here forward get the new default of false, needing their
-- own explicit opt-in even when the device's OS permission is already
-- granted from a different account.
update public.profiles set calendar_sync_enabled = true where created_at < now();
