"use client";

// Which exchange rate the footer of Discord payout notifications shows:
// a CoinGecko coin (ADA by default, or any other) in a fiat currency, or
// none. Admin-only row inside the Community card on the Members page.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { COINGECKO_ID_RE, FIAT_CURRENCY_RE } from "@/lib/api/schemas";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Input, NoticeText, Select } from "@/components/ui";

const ADA_COIN = "cardano";
type Choice = "ada" | "none" | "custom";

function choiceFor(coin: string | null): Choice {
  if (coin === null) return "none";
  return coin === ADA_COIN ? "ada" : "custom";
}

export function DiscordRateSetting({
  communityId,
  coin,
  currency,
  onSaved,
}: {
  communityId: string;
  /** CoinGecko coin id; null = date only. */
  coin: string | null;
  currency: string;
  onSaved: () => void;
}) {
  const [choice, setChoice] = useState<Choice>(choiceFor(coin));
  const [customCoin, setCustomCoin] = useState(choiceFor(coin) === "custom" ? (coin ?? "") : "");
  const [fiat, setFiat] = useState(currency);
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAsyncAction();

  const nextCoin = choice === "none" ? null : choice === "ada" ? ADA_COIN : customCoin.trim().toLowerCase();
  const nextFiat = fiat.trim().toLowerCase();
  const valid =
    (nextCoin === null || COINGECKO_ID_RE.test(nextCoin)) && FIAT_CURRENCY_RE.test(nextFiat);
  const dirty = nextCoin !== coin || nextFiat !== currency;

  async function save() {
    setNotice(null);
    const ok = await action.run(() =>
      apiFetch("/api/community", {
        method: "PATCH",
        body: { communityId, discordRateCoin: nextCoin, discordRateCurrency: nextFiat },
      }),
    );
    if (!ok) return;
    setNotice("Saved. New payout notifications use this rate.");
    onSaved();
  }

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <label className="text-sm text-zinc-400">Discord exchange rate</label>
        <Select value={choice} disabled={action.busy} onChange={(e) => setChoice(e.target.value as Choice)}>
          <option value="ada">ADA</option>
          <option value="custom">Another coin…</option>
          <option value="none">None (date only)</option>
        </Select>
        {choice === "custom" && (
          <Input
            value={customCoin}
            disabled={action.busy}
            onChange={(e) => setCustomCoin(e.target.value)}
            placeholder="CoinGecko id, e.g. singularitynet"
            className="max-w-xs font-mono text-xs"
            spellCheck={false}
          />
        )}
        {choice !== "none" && (
          <span className="flex items-center gap-2 text-sm text-zinc-400">
            in
            <Input
              value={fiat}
              disabled={action.busy}
              onChange={(e) => setFiat(e.target.value)}
              maxLength={5}
              className="w-20 font-mono text-xs uppercase"
              aria-label="Fiat currency"
            />
          </span>
        )}
        <Button onClick={() => void save()} loading={action.busy} disabled={!valid || !dirty}>
          {action.busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        Shown in the footer of payout notifications, e.g. &quot;Exchange rate — 0.42 USD per ADA&quot;.
        Prices come from CoinGecko; a coin&apos;s id is the last part of its coingecko.com URL.
      </p>
      <ErrorText error={action.error} className="mt-2" />
      <NoticeText className="mt-2">{notice}</NoticeText>
    </div>
  );
}
