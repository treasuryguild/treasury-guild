-- Workgroup -> wallet routing: a workgroup is payable from at most one
-- treasury; NULL means payable from any community wallet (assignment is an
-- opt-in restriction, so no backfill). The composite FK guarantees the
-- treasury belongs to the same community as the workgroup — MATCH SIMPLE
-- skips the check while treasury_id is NULL.
--
-- treasury_id is admin-writable client-side via the existing workgroups_write
-- policy: it is routing metadata about the workgroup, not treasury state, and
-- the build-payout route independently re-validates the assignment.

alter table treasuries
  add constraint treasuries_id_community_unique unique (id, community_id);

alter table workgroups add column treasury_id uuid;

alter table workgroups
  add constraint workgroups_treasury_same_community
  foreign key (treasury_id, community_id)
  references treasuries (id, community_id)
  on delete set null (treasury_id);

create index workgroups_treasury_idx on workgroups (treasury_id);

-- community_assets: shape unchanged, but rows are now written exclusively by
-- the build-payout route (service role) when a bounty field is auto-matched
-- to a wallet token's ticker or manually connected on the Payday page.
