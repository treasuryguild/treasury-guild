-- Optional community profile picture: bare IPFS CID (same shape as
-- mints.image_cid). Cleared by setting null; the pin on IPFS stays public.

alter table public.communities
  add column avatar_cid text;

comment on column public.communities.avatar_cid is
  'IPFS CID of the community profile picture; null when unset. Public and permanent on IPFS.';
