-- A community chooses its Cardano network (0 = preprod, 1 = mainnet) once,
-- at creation. Every treasury it owns must live on that same network: the
-- multisig address is derived for one network, and payouts, mints and
-- reconciliation all read `treasuries.network`. Nothing enforced the pair
-- before, so a deployment whose default network changed between creating a
-- community and creating its treasury could end up with a mainnet wallet in
-- a preprod community. Now the database refuses. (The community side has no
-- writer for `network` after insert: there is no client write policy and no
-- API route updates it.)
create function public.guard_treasury_network() returns trigger
language plpgsql security definer set search_path = public as $$
declare community_network smallint;
begin
  select network into community_network from communities where id = new.community_id;
  if community_network is null then
    raise exception 'Community not found' using errcode = 'P0002';
  end if;
  if new.network <> community_network then
    raise exception 'Treasury network (%) must match the community network (%)',
      new.network, community_network using errcode = '23514';
  end if;
  return new;
end $$;

create trigger treasury_network_matches_community
  before insert or update of network, community_id on public.treasuries
  for each row execute function public.guard_treasury_network();
