# Community stake pools (design)

Agent-facing note for migration 0099. User docs: `/docs/treasury#stake-pools`.

## Rules

1. Link by `pool1…` / ticker; cache params from Koios `/pool_list` + `/pool_info`.
2. On link / refresh, best-effort cache `icon_url` from Koios `/pool_metadata` + CIP-6 / AdaPools extended JSON (SSRF-safe fetch; HTTPS only).
3. Book **income once** when ADA is spendable in a **community treasury**.
4. Taxonomy: `incoming_type = revenue` + pool `funding_source_id` + `stake_pool_id`. No new incoming enum.
5. Rewards buffers are float wallets with `purpose = pool_rewards` (share the float cap of 5).
6. Cap **3** active linked pools per community.

## Topologies

```
Epoch rewards → reward account
  ├─ withdraw → community treasury     → revenue (+ funding source)
  └─ withdraw → rewards buffer float
                  └─ forward → treasury → revenue (+ funding source; keep from_float_wallet_id)
```

SDK treasuries that withdraw matching the pool reward stake address get a companion `incoming_txs` row (withdraws are not ordinary inflows).

## Tables

- `community_stake_pools`, `stake_pool_wallets`
- `float_wallets.purpose`, `incoming_txs.stake_pool_id`
- RPC `classify_pool_reward_inflows` after `tag_float_transfers`

## UI

- Treasury page **Stake pools** section: link, refresh, map roles, archive; small icon beside the ticker when `icon_url` is set.
- **Create rewards buffer float** from the mapping UI (`purpose: pool_rewards`);
  **Add float wallet** creates a DEX float (`purpose: dex`) only.

## Out of scope (v1)

Epoch ROS / blocks / saturation dashboards; planned-vs-received commitments for margin; Agent API tools.
