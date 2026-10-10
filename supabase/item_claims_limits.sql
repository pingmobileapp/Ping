-- Enforces "what to bring" limits in the database instead of only on the
-- phone. Run this in the Supabase SQL Editor (Dashboard -> SQL Editor ->
-- New query).
--
-- Why (TestFlight feedback, build 106): an item needing 1 ended up "3/1
-- claimed". The Full check in EventDetailContent's handleClaim only looked
-- at whatever claims that phone loaded when the event was opened, so a
-- guest whose screen predated someone else's claim could still claim it,
-- and two quick taps on Claim each inserted their own row (the same person
-- listed twice). Nothing server-side stopped either.

-- Run this first - the unique index below fails if it returns rows.
select item_id, invitee_id, count(*)
from public.item_claims
group by item_id, invitee_id
having count(*) > 1;

-- One claim row per person per item. Steppers update that row's quantity
-- and write-in items already allow only one entry each, so the app never
-- meant to create a second one.
create unique index if not exists item_claims_item_invitee_unique
  on public.item_claims (item_id, invitee_id);

-- Rejects a claim that would push an item past quantity_needed. Locking the
-- item row first makes two simultaneous claims take turns, so the second
-- one sees the first. Write-in items (allow_custom) have no cap - everyone
-- can say what they're bringing.
create or replace function public.enforce_item_claim_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_needed integer;
  v_custom boolean;
  v_others integer;
begin
  select quantity_needed, allow_custom into v_needed, v_custom
  from public.items
  where id = new.item_id
  for update;

  if v_custom then
    return new;
  end if;

  select coalesce(sum(quantity), 0) into v_others
  from public.item_claims
  where item_id = new.item_id
    and id <> new.id;

  if v_others + new.quantity > v_needed then
    raise exception 'item_full' using errcode = 'P0001',
      hint = 'Someone else already claimed what this item needs.';
  end if;

  return new;
end;
$$;

drop trigger if exists item_claims_limit on public.item_claims;
create trigger item_claims_limit
  before insert or update of quantity on public.item_claims
  for each row execute function public.enforce_item_claim_limit();
