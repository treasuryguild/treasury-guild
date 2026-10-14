-- contributor_balances (0006, recreated in 0009) is a plain view: it runs with
-- its owner's privileges, so it bypasses the RLS on payouts and reconciliations,
-- and the project's legacy default privileges expose it through PostgREST to
-- anon. That let anyone with the anon key list every payee wallet and its net
-- paid amount per unit across all communities, private ones included. Nothing
-- in the app reads it; contributor totals are computed in code from payouts.
drop view if exists public.contributor_balances;
