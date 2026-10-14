-- Rows the agent API creates from a confirmed draft (MCP draft_confirm) are
-- keyed by that draft, as proposals are since 0064: a payout transaction, a
-- task and a call each carry the draft token's random id (its jti), so a
-- confirmation sent twice, even at once, finds the row the first one made
-- instead of making a second. No personal data; null for rows made in the app.
--
-- Only the service role writes these: transactions and calls have no client
-- write policies, and the browser's task grants (0046) list their columns
-- explicitly, so the new column is not among them.

alter table public.transactions add column agent_draft_id text;
create unique index transactions_agent_draft_uq on public.transactions (agent_draft_id)
  where agent_draft_id is not null;

alter table public.tasks add column agent_draft_id text;
create unique index tasks_agent_draft_uq on public.tasks (agent_draft_id)
  where agent_draft_id is not null;

alter table public.calls add column agent_draft_id text;
create unique index calls_agent_draft_uq on public.calls (agent_draft_id)
  where agent_draft_id is not null;
