-- Community visibility + membership onboarding.
--
-- visibility is a text check (matching workgroups.kind / tasks.source style)
-- rather than an enum so a future 'unlisted' needs no ALTER TYPE. Default
-- private for existing AND new rows: nothing becomes discoverable without an
-- admin opting in.

alter table communities add column visibility text not null default 'private'
  check (visibility in ('public', 'private'));

-- Discovery-aware read policy, replacing using(true): public rows stay
-- world-readable (anon key included, so a logged-out /discover works);
-- private rows become member-only. Non-members of a private community now
-- get zero rows and the UI's existing "Community not found" branch — before
-- this, the name/description of every community leaked to anyone.
drop policy communities_read on communities;
create policy communities_read on communities
  for select using (visibility = 'public' or public.is_member(id));

-- workgroups.kind becomes the source of truth for board rendering (the UI
-- previously inferred GitHub-ness from the synced tasks, so an empty GitHub
-- workgroup rendered as a native kanban). Backfill from the actual repo
-- links; the /api/github/repos route maintains it from now on.
update workgroups w set kind = 'github'
  where exists (select 1 from github_repos r where r.workgroup_id = w.id);
