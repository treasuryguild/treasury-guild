-- Store the immutable GitHub user id on github assignee rows so an OAuth
-- link after a login rename cannot claim another person's unpaid tasks or
-- auto-join their communities. Matching on login alone is refused; rows
-- without an id stay unverified until the next sync writes one.

alter table public.task_assignees
  add column gh_user_id bigint;

create index task_assignees_gh_user_id_idx
  on public.task_assignees (gh_user_id)
  where gh_user_id is not null and wallet_address is null;
