-- Keep budget token labels and decimal precision stable even after a token
-- leaves the treasury wallet or its external metadata becomes unavailable.

alter table workgroup_budgets
  add column asset_label text,
  add column decimals int not null default 0 check (decimals between 0 and 12);

update workgroup_budgets
set asset_label = 'ADA', decimals = 6
where unit = 'lovelace';
