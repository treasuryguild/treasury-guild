-- Route hardening (2026-10-01 route review): writes that were a check
-- followed by a separate write, or several writes without a transaction,
-- become one database step each.
--
--   1. auth_nonces: several open challenges per address. One row per address
--      let anyone replace another wallet's challenge mid-signature.
--   2. Calls: the reward edit, the delete and the finalize lock the call row
--      and check its attendance tasks in the same step.
--   3. replace_task_assignees: a task's assignee set is replaced atomically,
--      under the task's row lock, refused once the task is settled.
--   4. save_call_integration: a host connection and its tokens are saved
--      together.

-- 1. Login challenges ---------------------------------------------------------

-- Keyed by the challenge itself; verify names the challenge it signed.
alter table public.auth_nonces drop constraint auth_nonces_pkey;
alter table public.auth_nonces add primary key (nonce);
create index auth_nonces_address_idx on public.auth_nonces (address);
create index auth_nonces_expires_idx on public.auth_nonces (expires_at);

-- 2. Calls ----------------------------------------------------------------------

-- The reward is what the attendance tasks carry: locked once one exists.
create function public.set_call_amounts(p_call_id uuid, p_amounts jsonb) returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform 1 from calls where id = p_call_id for update;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  if exists (select 1 from call_tasks where call_id = p_call_id) then
    raise exception 'The reward is locked once attendance tasks exist' using errcode = '23514';
  end if;
  update calls set amounts = p_amounts where id = p_call_id;
end $$;
revoke all on function public.set_call_amounts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_call_amounts(uuid, jsonb) to service_role;

-- A call with attendance tasks stays as their record.
create function public.delete_call_without_tasks(p_call_id uuid) returns void
language plpgsql security invoker set search_path = public as $$
begin
  perform 1 from calls where id = p_call_id for update;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  if exists (select 1 from call_tasks where call_id = p_call_id) then
    raise exception 'This call already has attendance tasks and stays as their record' using errcode = '23514';
  end if;
  delete from calls where id = p_call_id;
end $$;
revoke all on function public.delete_call_without_tasks(uuid) from public, anon, authenticated;
grant execute on function public.delete_call_without_tasks(uuid) to service_role;

-- finalize_call (0037) copies the locked row's amounts, while the route
-- derives bounty_lovelace from the amounts it read earlier: refuse when they
-- differ, so a task's amounts and bounty always agree. The row lock is
-- re-entrant, so finalize_call takes it again in the same transaction.
create function public.finalize_call_at_reward(
  p_call_id uuid, p_actor text, p_attendee_ids uuid[], p_chunk int, p_bounty_lovelace bigint, p_amounts jsonb
) returns jsonb language plpgsql security invoker set search_path = public as $$
declare v_amounts jsonb;
begin
  select amounts into v_amounts from calls where id = p_call_id for update;
  if not found then raise exception 'Call not found' using errcode = 'P0002'; end if;
  if v_amounts is distinct from p_amounts then
    raise exception 'The reward changed while finalizing: reload the call and try again' using errcode = '23514';
  end if;
  return finalize_call(p_call_id, p_actor, p_attendee_ids, p_chunk, p_bounty_lovelace);
end $$;
revoke all on function public.finalize_call_at_reward(uuid, text, uuid[], int, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.finalize_call_at_reward(uuid, text, uuid[], int, bigint, jsonb) to service_role;

-- 3. Task assignees ------------------------------------------------------------

-- p_assignees: [{source: "github", id, wallet|null} | {source: "manual", wallet}],
-- in display order. The route has checked the github ids are exactly the
-- task's; manual rows are replaced. Settled tasks (queued, paid, reconciled,
-- or with payouts in a live transaction) are locked: the set is the paid-to
-- record. guard_task_assignee_write still refuses archived tasks/workgroups.
create function public.replace_task_assignees(p_task_id uuid, p_assignees jsonb) returns void
language plpgsql security invoker set search_path = public as $$
declare t public.tasks;
begin
  select * into t from tasks where id = p_task_id for update;
  if not found then raise exception 'Task not found' using errcode = 'P0002'; end if;
  if t.pay_state in ('queued', 'paid', 'reconciled') or exists (
      select 1 from payouts p join transactions x on x.id = p.transaction_id
      where p.task_id = p_task_id and x.state in (0, 1, 2)) then
    raise exception 'Assignees are locked once a payout has been queued or paid' using errcode = '23514';
  end if;

  delete from task_assignees where task_id = p_task_id and source = 'manual';
  -- Clear first: two github rows may swap wallets, and a wallet is unique per task.
  update task_assignees set wallet_address = null where task_id = p_task_id and source = 'github';
  update task_assignees a set wallet_address = x.value->>'wallet', position = (x.ord - 1)::int
    from jsonb_array_elements(p_assignees) with ordinality x(value, ord)
    where x.value->>'source' = 'github' and a.id = (x.value->>'id')::uuid
      and a.task_id = p_task_id and a.source = 'github';
  insert into task_assignees (task_id, source, wallet_address, position)
    select p_task_id, 'manual', x.value->>'wallet', (x.ord - 1)::int
    from jsonb_array_elements(p_assignees) with ordinality x(value, ord)
    where x.value->>'source' = 'manual';
end $$;
revoke all on function public.replace_task_assignees(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.replace_task_assignees(uuid, jsonb) to service_role;

-- 4. Host connections -----------------------------------------------------------

-- Connect (or re-point) a community's account on a platform and, when the
-- platform issues them, its tokens: one step, so a row never names one
-- account while holding another's tokens. Without tokens (Discord: the bot
-- token is the application's), any stored ones are dropped.
create function public.save_call_integration(
  p_community_id uuid, p_provider text, p_external_account_id text, p_label text, p_created_by text,
  p_access_token text, p_refresh_token text, p_expires_at timestamptz
) returns uuid language plpgsql security invoker set search_path = public as $$
declare v_id uuid;
begin
  insert into call_integrations (community_id, provider, external_account_id, label, created_by, created_at)
    values (p_community_id, p_provider, p_external_account_id, p_label, p_created_by, now())
    on conflict (community_id, provider) do update set
      external_account_id = excluded.external_account_id, label = excluded.label,
      created_by = excluded.created_by, created_at = excluded.created_at
    returning id into v_id;
  if p_access_token is null then
    delete from call_integration_secrets where integration_id = v_id;
  else
    insert into call_integration_secrets (integration_id, access_token, refresh_token, expires_at, updated_at)
      values (v_id, p_access_token, p_refresh_token, p_expires_at, now())
      on conflict (integration_id) do update set
        access_token = excluded.access_token, refresh_token = excluded.refresh_token,
        expires_at = excluded.expires_at, updated_at = excluded.updated_at;
  end if;
  return v_id;
end $$;
revoke all on function public.save_call_integration(uuid, text, text, text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.save_call_integration(uuid, text, text, text, text, text, text, timestamptz) to service_role;
