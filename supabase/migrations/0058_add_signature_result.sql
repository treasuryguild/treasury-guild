-- add_signature (0002) ended in `update ... returning true`, so a signature
-- that did not land came back as NULL, not false. It answers false now. The
-- service role's right to call it is also stated here instead of being left
-- to the default function privileges (0007 only revoked the browser roles).

create or replace function public.add_signature(p_tx uuid, p_addr text, p_cbor text, p_expected int)
returns boolean
language sql
security definer
set search_path = public
as $$
  with landed as (
    update transactions
    set tx_cbor = p_cbor,
        signed_addresses = array_append(signed_addresses, p_addr)
    where id = p_tx
      and state = 0
      and cardinality(signed_addresses) = p_expected
      and not (p_addr = any(signed_addresses))
    returning 1
  )
  select exists (select 1 from landed);
$$;

revoke execute on function public.add_signature(uuid, text, text, int) from public, anon, authenticated;
grant execute on function public.add_signature(uuid, text, text, int) to service_role;
