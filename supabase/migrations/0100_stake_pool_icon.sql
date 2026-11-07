-- Cache the HTTPS icon URL from CIP-6 / AdaPools-style extended pool metadata
-- (resolved on link and Refresh from chain; browser loads it directly).

alter table public.community_stake_pools
  add column icon_url text
    check (icon_url is null or char_length(icon_url) between 1 and 512);

comment on column public.community_stake_pools.icon_url is
  'HTTPS URL of the pool icon from extended metadata; null when unknown or unavailable.';
