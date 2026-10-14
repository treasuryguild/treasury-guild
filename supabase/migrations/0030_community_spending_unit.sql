-- The token a community mainly budgets and spends: charted first and listed
-- first on the Dashboard. 'lovelace' (ADA) by default. Any other unit must be
-- one the community has paid out (community_assets) or a treasury currently
-- holds — enforced in PATCH /api/community, not here. Display-only and
-- member-readable like the Discord rate columns; the row-level read policy
-- on communities already covers it.

alter table communities
  add column spending_unit text not null default 'lovelace'
    check (spending_unit = 'lovelace' or spending_unit ~ '^[0-9a-f]{56,120}$');
