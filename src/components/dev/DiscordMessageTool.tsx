"use client";

// Dev tool: preview the Discord payout message scenarios and post them to a
// webhook of your choice. The URL is remembered in this browser only.
import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { DISCORD_WEBHOOK_URL_RE } from "@/lib/api/schemas";
import { DISCORD_SCENARIOS, type DiscordScenarioId } from "@/lib/discord/fixtures";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Input, JsonDetails, NoticeText, Select } from "@/components/ui";
import { DiscordEmbedPreview } from "./DiscordEmbedPreview";

const URL_STORAGE_KEY = "gv:dev:discord-webhook";

function readStoredUrl(): string {
  try {
    return window.localStorage.getItem(URL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeUrl(url: string): void {
  try {
    window.localStorage.setItem(URL_STORAGE_KEY, url);
  } catch {
    // storage unavailable: the URL just isn't remembered
  }
}

export function DiscordMessageTool() {
  const [url, setUrl] = useState("");
  const [scenarioId, setScenarioId] = useState<DiscordScenarioId>("kitchen-sink");
  const [notice, setNotice] = useState<string | null>(null);
  const action = useAsyncAction();

  useEffect(() => {
    setUrl(readStoredUrl());
  }, []);

  const scenario = DISCORD_SCENARIOS.find((s) => s.id === scenarioId) ?? DISCORD_SCENARIOS[0]!;
  const payload = useMemo(() => scenario.build(), [scenario]);
  const urlOk = DISCORD_WEBHOOK_URL_RE.test(url.trim());

  function onUrlChange(value: string) {
    setUrl(value);
    storeUrl(value);
  }

  async function send(ids: readonly DiscordScenarioId[]) {
    setNotice(null);
    let sent = 0;
    const ok = await action.run(async () => {
      for (const id of ids) {
        await apiFetch("/api/dev/discord", { body: { url: url.trim(), scenario: id } });
        sent += 1;
        setNotice(`Sent ${sent}/${ids.length} · ${id}`);
      }
    });
    if (ok !== undefined) setNotice(`Sent ${sent}/${ids.length} — check the channel.`);
    else if (sent > 0) setNotice(`Sent ${sent}/${ids.length} before the failure.`);
  }

  return (
    <div className="space-y-4">
      <Field
        label="Webhook URL"
        hint="A Discord incoming webhook (channel settings → Integrations → Webhooks). Remembered in this browser only."
      >
        <Input
          type="url"
          placeholder="https://discord.com/api/webhooks/…"
          value={url}
          onChange={(e) => onUrlChange(e.target.value)}
          spellCheck={false}
        />
      </Field>

      <Field label="Scenario" hint={scenario.description}>
        <Select value={scenarioId} onChange={(e) => setScenarioId(e.target.value as DiscordScenarioId)}>
          {DISCORD_SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </Select>
      </Field>

      <DiscordEmbedPreview payload={payload} />
      <JsonDetails label="Raw webhook payload" value={payload} />

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void send([scenario.id])} loading={action.busy} disabled={!urlOk}>
          {action.busy ? "Sending…" : "Send this scenario"}
        </Button>
        <Button
          variant="secondary"
          onClick={() => void send(DISCORD_SCENARIOS.map((s) => s.id))}
          loading={action.busy}
          disabled={!urlOk}
        >
          Send all scenarios
        </Button>
        {!urlOk && url.trim() !== "" && (
          <span className="text-xs text-amber-500">Not a Discord webhook URL.</span>
        )}
      </div>
      <ErrorText error={action.error} />
      <NoticeText>{notice}</NoticeText>
    </div>
  );
}
