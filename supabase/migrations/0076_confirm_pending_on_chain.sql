-- A fully signed pending transaction can be broadcast outside the app. The
-- poller and delete/reject routes then need to confirm it rather than release
-- its queued tasks back to payable (which would allow a second payout).
-- confirm_transaction previously required state = submitted only.

create or replace function public.confirm_transaction(p_transaction_id uuid, p_block_time timestamptz)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  x public.transactions;
begin
  select * into x from transactions where id = p_transaction_id for update;
  -- Pending (0) or submitted (1): a pending row whose hash is on-chain was
  -- broadcast outside the app's submit path.
  if not found or x.state not in (0, 1) then return false; end if;
  update transactions set
      state = 2,
      block_time = p_block_time,
      submitted_at = coalesce(submitted_at, p_block_time)
    where id = x.id;
  update payouts set status = 'confirmed'
    where transaction_id = x.id and status in ('pending', 'submitted');
  perform pay_tasks_for_tx(x.tx_hash,
    array(select distinct task_id from payouts where transaction_id = x.id));
  return true;
end $$;
