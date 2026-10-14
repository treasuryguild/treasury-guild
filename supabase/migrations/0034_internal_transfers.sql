-- Transfers between a community's own treasuries. The poller records such a
-- tx twice: an outgoing external_txs row at the sender and an unclassified
-- incoming_txs row at the receiver, which then sits in the review queue and
-- would count as income. tag_internal_transfers links both sides to the
-- counterparty treasury and classifies the inflow as a transfer that needs no
-- reconciliation. The receiver's incoming_txs row is the one source of a
-- transfer's amount; the sender's external_txs row is tagged for display only.
--
-- Idempotent and conservative: a row is tagged once (from_treasury_id /
-- to_treasury_id null), and an inflow an admin already classified keeps its
-- type. incoming_txs.tx_hash is the primary key, so a tx that pays two of the
-- community's treasuries is recorded once, at the first treasury polled.

alter table incoming_txs
  add column from_treasury_id uuid references treasuries(id) on delete set null;
create index incoming_txs_from_treasury_idx on incoming_txs(from_treasury_id)
  where from_treasury_id is not null;

alter table external_txs
  add column to_treasury_id uuid references treasuries(id) on delete set null;

create function public.tag_internal_transfers(p_community_id uuid) returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_incoming integer;
  v_external integer;
begin
  update incoming_txs i
    set from_treasury_id = s.id,
        incoming_type = case when i.incoming_type = 'unclassified' and not i.matched
          then 'transfer' else i.incoming_type end,
        requires_reconciliation = case when i.incoming_type = 'unclassified' and not i.matched
          then false else i.requires_reconciliation end,
        matched = case when i.incoming_type = 'unclassified' and not i.matched
          then true else i.matched end
    from treasuries r, treasuries s
    where r.id = i.treasury_id and r.community_id = p_community_id
      and s.community_id = p_community_id and s.id <> r.id
      and s.address = any(i.from_addresses)
      and i.from_treasury_id is null;
  get diagnostics v_incoming = row_count;

  update external_txs e
    set to_treasury_id = t.id
    from treasuries r, treasuries t
    where r.id = e.treasury_id and r.community_id = p_community_id
      and t.community_id = p_community_id and t.id <> r.id
      and t.address = any(e.to_addresses)
      and e.to_treasury_id is null;
  get diagnostics v_external = row_count;

  return v_incoming + v_external;
end $$;
revoke all on function public.tag_internal_transfers(uuid) from public, authenticated, anon;
grant execute on function public.tag_internal_transfers(uuid) to service_role;

-- Backfill every community once; later rows are tagged by the poller.
select public.tag_internal_transfers(id) from communities;
