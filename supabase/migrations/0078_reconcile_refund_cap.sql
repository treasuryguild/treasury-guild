-- One reconciliation per inflow, so two racing matches cannot both credit a
-- refund against spend. The route also caps amount/unit against the inflow
-- (and the linked payout); this unique index closes the race.

create unique index reconciliations_incoming_uq
  on public.reconciliations (incoming_tx_hash);
