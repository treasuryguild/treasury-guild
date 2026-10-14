-- Treasury templates and spending paths (docs/onchain-anchoring-estimate.md,
-- phases 6 and 7):
--
--   * a treasury has a fixed template: 'plain' (the flat multisig of today),
--     'clawback' (any[base, all[recovery, after(slot)]]: the base signers can
--     always spend, the recovery signers too from the lock date), 'lock_until'
--     (all[base, after(slot)]: nobody spends before the date) or 'cosigner'
--     (any[all[base, sig(co-signer)], all[every base signer]]: the base rule
--     plus one co-signer that signs only what passes the app's check, or every
--     base signer together). The template, lock and recovery rule are stored
--     beside the script and checked against it at every use;
--   * treasury_signers carries the group a key belongs to ('base', 'recovery'
--     or 'cosigner'); the primary key (treasury_id, key_hash) already refuses
--     one key in two groups;
--   * every transaction is built for one spending path ('base', 'recovery',
--     'cosigned' or 'bypass') and stores it, so the routes and the signing
--     page count exactly that path's signatures; a trigger refuses a path the
--     treasury's template does not offer;
--   * the app-held co-signer key (phase 7b) lives encrypted in
--     treasury_cosigner_keys (no policies: service role only) and every
--     pass/fail decision of the check is logged in cosigner_decisions
--     (member-readable, never a key).

-- 1. Treasury template columns -------------------------------------------------

alter table public.treasuries
  add column template text not null default 'plain'
    check (template in ('plain', 'clawback', 'lock_until', 'cosigner')),
  add column lock_slot bigint check (lock_slot is null or lock_slot > 0),
  add column lock_until timestamptz,
  add column recovery_script_type text
    check (recovery_script_type in ('atLeast', 'all', 'any')),
  add column recovery_required smallint
    check (recovery_required is null or recovery_required >= 1),
  add column cosigner_kind text check (cosigner_kind in ('member', 'app'));

-- The lock columns exist exactly for the two time-lock templates, the
-- recovery rule exactly for clawback, the co-signer kind exactly for cosigner.
alter table public.treasuries add constraint treasuries_template_columns_check check (
  ((template in ('clawback', 'lock_until')) = (lock_slot is not null and lock_until is not null)) and
  ((template = 'clawback') = (recovery_script_type is not null and recovery_required is not null)) and
  ((template = 'cosigner') = (cosigner_kind is not null))
);

-- 2. Signer groups -------------------------------------------------------------

alter table public.treasury_signers
  add column signer_group text not null default 'base'
    check (signer_group in ('base', 'recovery', 'cosigner'));

-- 3. Spending path of a transaction -------------------------------------------

alter table public.transactions
  add column spending_path text not null default 'base'
    check (spending_path in ('base', 'recovery', 'cosigned', 'bypass'));

-- The path must be one the treasury's template offers.
create function public.guard_transaction_path() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_template text;
begin
  select template into v_template from treasuries where id = new.treasury_id;
  if v_template is null then
    raise exception 'Treasury not found' using errcode = 'P0002';
  end if;
  if not (
    (v_template in ('plain', 'lock_until') and new.spending_path = 'base') or
    (v_template = 'clawback' and new.spending_path in ('base', 'recovery')) or
    (v_template = 'cosigner' and new.spending_path in ('cosigned', 'bypass'))
  ) then
    raise exception 'Spending path % is not offered by a % treasury', new.spending_path, v_template
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_transaction_path() from public, anon, authenticated;

create trigger transactions_guard_path
  before insert or update of spending_path, treasury_id on public.transactions
  for each row execute function public.guard_transaction_path();

-- 4. The app-held co-signer key ------------------------------------------------

-- One key per co-signer treasury with cosigner_kind = 'app', generated at
-- creation and never rotated (the script is fixed). encrypted_key is
-- "v1:<iv>:<tag>:<ciphertext>" (base64 parts, AES-256-GCM under
-- COSIGNER_KEY_SECRET). Service role only: no policies.
create table public.treasury_cosigner_keys (
  treasury_id uuid primary key references public.treasuries(id) on delete cascade,
  key_hash text not null check (key_hash ~ '^[0-9a-f]{56}$'),
  public_key_hex text not null check (public_key_hex ~ '^[0-9a-f]{64}$'),
  encrypted_key text not null,
  created_at timestamptz not null default now()
);
alter table public.treasury_cosigner_keys enable row level security;
revoke all on public.treasury_cosigner_keys from public, anon, authenticated, service_role;
grant select, insert, delete on public.treasury_cosigner_keys to service_role;

-- 5. Co-signer decisions -------------------------------------------------------

-- Every run of the check on a co-signed transaction: what triggered it,
-- whether it passed, the problems in words, and whether the app's witness
-- was added (only ever after a pass).
create table public.cosigner_decisions (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.transactions(id) on delete cascade,
  decided_at timestamptz not null default now(),
  trigger text not null check (trigger in ('sign', 'manual', 'sweep')),
  passed boolean not null,
  problems jsonb not null default '[]'::jsonb,
  signed boolean not null default false,
  check (signed = false or passed)
);
create index cosigner_decisions_tx_idx on public.cosigner_decisions(transaction_id, decided_at desc);

-- 6. Access --------------------------------------------------------------------

alter table public.cosigner_decisions enable row level security;
create policy cosigner_decisions_read on public.cosigner_decisions for select
  using (exists (
    select 1 from public.transactions x join public.treasuries t on t.id = x.treasury_id
    where x.id = transaction_id and public.is_member(t.community_id)
  ));
revoke all on public.cosigner_decisions from anon, authenticated, service_role;
grant select on public.cosigner_decisions to authenticated;
grant select, insert on public.cosigner_decisions to service_role;
