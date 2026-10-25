-- Open "what to bring" lists: a guest can add several things to a
-- write-in item (allow_custom), not just one. Asked for 2026-10-24 - a host
-- made four separate "Side" items just to bring four dishes.
--
-- The unique (item_id, invitee_id) index from item_claims_limits.sql stays
-- in force for specific items only: it moves into enforce_item_claim_limit,
-- which already knows whether the item is a write-in. The error keeps code
-- 23505, which the app already treats as "you already have that one".

drop index if exists public.item_claims_item_invitee_unique;

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
    -- Several entries per person are fine; the same text twice is a
    -- double tap.
    if tg_op = 'INSERT' and exists (
      select 1 from public.item_claims
      where item_id = new.item_id
        and invitee_id = new.invitee_id
        and lower(trim(coalesce(note, ''))) = lower(trim(coalesce(new.note, '')))
    ) then
      raise exception 'duplicate_claim' using errcode = '23505';
    end if;
    return new;
  end if;

  -- Specific items: one claim row per person (the stepper changes its
  -- quantity), and never more than the item needs.
  if tg_op = 'INSERT' and exists (
    select 1 from public.item_claims
    where item_id = new.item_id and invitee_id = new.invitee_id
  ) then
    raise exception 'duplicate_claim' using errcode = '23505';
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
