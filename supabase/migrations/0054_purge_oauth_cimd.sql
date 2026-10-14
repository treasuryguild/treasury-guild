-- Agent API retention: purge Client ID Metadata Document clients nobody
-- approved, too.
--
-- Any unauthenticated /api/oauth/authorize or /token request whose client_id
-- is an https URL serving a valid document caches that document as an
-- oauth_clients row. 0053's purge_oauth kept every such row, so a caller
-- rotating IPs and URLs could grow the table without bound. A metadata-URL
-- client with no grant and no refresh token, not seen for a day, is now
-- deleted like an unapproved DCR client; it is simply re-fetched if it comes
-- back. Rows removed are still counted in the return value.
create or replace function public.purge_oauth(p_now timestamptz)
returns integer
language plpgsql set search_path = public as $$
declare
  removed integer := 0;
  n integer;
begin
  delete from oauth_authorization_codes where expires_at < p_now - interval '1 day';
  get diagnostics n = row_count; removed := removed + n;

  delete from oauth_refresh_tokens where expires_at < p_now;
  get diagnostics n = row_count; removed := removed + n;

  -- DCR clients by registration age, metadata-document clients by last fetch.
  delete from oauth_clients c
  where (case when c.is_metadata_url then c.last_seen_at else c.created_at end) < p_now - interval '1 day'
    and not exists (select 1 from oauth_grants g where g.client_id = c.client_id)
    and not exists (select 1 from oauth_refresh_tokens r where r.client_id = c.client_id);
  get diagnostics n = row_count; removed := removed + n;

  return removed;
end $$;
revoke all on function public.purge_oauth(timestamptz) from public, anon, authenticated;
grant execute on function public.purge_oauth(timestamptz) to service_role;
