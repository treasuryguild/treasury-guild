-- A browser-set tasks.budget_month in a future calendar month would give a
-- recurring budget unlimited headroom (no spent totals there yet). Cap it at
-- the current UTC month; build-payout and the co-signer refuse the same.

create or replace function public.guard_task_client_write() returns trigger
language plpgsql set search_path = public as $$
begin
  -- Only a browser session is held to this; service-role calls and direct
  -- database sessions (migrations, seeds) carry no 'authenticated' role.
  if coalesce(auth.jwt() ->> 'role', '') <> 'authenticated' then
    return new;
  end if;
  if new.pay_state is distinct from old.pay_state and not (
    old.source = 'native'
    and old.pay_state in ('none', 'payable')
    and new.pay_state in ('none', 'payable')
  ) then
    raise exception 'The payment state of this task is set by its payout' using errcode = '42501';
  end if;
  if old.pay_state in ('queued', 'paid', 'reconciled') and (
    new.amounts is distinct from old.amounts
    or new.bounty_lovelace is distinct from old.bounty_lovelace
    or new.budget_month is distinct from old.budget_month
  ) then
    raise exception 'A task in a payout keeps its amounts and budget period' using errcode = '23514';
  end if;
  if new.budget_month is distinct from old.budget_month
    and new.budget_month is not null
    and to_char(new.budget_month at time zone 'UTC', 'YYYY-MM')
      > to_char((timezone('utc', now())), 'YYYY-MM')
  then
    raise exception 'A task budget period cannot be in the future' using errcode = '23514';
  end if;
  return new;
end $$;
