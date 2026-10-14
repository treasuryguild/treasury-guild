-- GitHub Project v2 field import: per-repo review-column filter and raw
-- number-field amounts on tasks.

-- Issues are only imported while their project item sits in this status
-- column (AND they carry payable_label). Case-insensitive match.
alter table github_repos
  add column import_status text not null default 'In review';

-- Raw Project v2 number-field values keyed by field name, as decimal strings
-- (e.g. {"ADA":"7","AGIX":"10","MINS":"30"}). Scaling to on-chain quantities
-- happens in code via the community_assets registry.
alter table tasks
  add column amounts jsonb;
