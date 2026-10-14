-- Which exchange rate a community wants in the footer of its Discord payout
-- notifications: a CoinGecko coin id (NULL = no rate, date only) and the
-- fiat currency to quote it in. Display-only, so plain member-readable
-- columns on communities (unlike the webhook URL, which is a secret).

alter table communities
  add column discord_rate_coin text default 'cardano'
    check (discord_rate_coin ~ '^[a-z0-9-]{1,64}$'),
  add column discord_rate_currency text not null default 'usd'
    check (discord_rate_currency ~ '^[a-z]{3,5}$');
