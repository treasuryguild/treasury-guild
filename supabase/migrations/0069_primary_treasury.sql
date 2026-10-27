-- Primary treasury: the one wallet whose base signers are community admins.
-- Later treasuries' base signers stay members (or their existing role) and
-- only act for that wallet. Admins may re-point the primary; the app
-- promotes the new primary's base signers and never auto-demotes.

alter table public.communities
  add column primary_treasury_id uuid references public.treasuries(id) on delete restrict;

comment on column public.communities.primary_treasury_id is
  'The treasury whose base signers are community admins; null until the first treasury exists.';

-- Oldest treasury per community (then id) becomes primary.
update public.communities c
set primary_treasury_id = t.id
from (
  select distinct on (community_id) id, community_id
  from public.treasuries
  order by community_id, created_at, id
) t
where c.id = t.community_id;

-- The primary must belong to the same community (app also checks; this
-- catches a bad manual update).
create or replace function public.guard_primary_treasury()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if new.primary_treasury_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.treasuries
    where id = new.primary_treasury_id and community_id = new.id
  ) then
    raise exception 'primary_treasury_id must be a treasury of this community'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger communities_guard_primary
  before insert or update of primary_treasury_id on public.communities
  for each row execute function public.guard_primary_treasury();
