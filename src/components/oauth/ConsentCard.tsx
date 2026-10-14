"use client";

// Approve or deny an AI assistant's request to act for the session wallet.
// The server re-checks everything shown here from the signed handle; the
// ticked permissions can only narrow what the assistant asked for.

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OAuthDecisionResponse, OAuthRequestResponse } from "@/lib/api/types";
import { shortAddress } from "@/lib/format";
import { isWriteScope } from "@/lib/mcp/scopes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ErrorText, WarningText } from "@/components/ui";

export function ConsentCard({
  handle,
  request,
  wallet,
}: {
  handle: string;
  request: OAuthRequestResponse;
  wallet: string;
}) {
  // A write permission starts unticked: the user opts into it, never out of it.
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(request.scopes.map((s) => s.scope).filter((scope) => !isWriteScope(scope))),
  );
  const [decided, setDecided] = useState(false);
  const decision = useAsyncAction("Could not record your decision");

  function toggle(scope: string, on: boolean) {
    setChosen((prev) => {
      const next = new Set(prev);
      if (on) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }

  async function decide(approved: boolean) {
    const result = await decision.run(() =>
      apiFetch<OAuthDecisionResponse>("/api/oauth/decision", {
        body: { request: handle, approved, scopes: [...chosen] },
      }),
    );
    if (result) {
      setDecided(true);
      window.location.assign(result.redirectTo);
    }
  }

  const busy = decision.busy || decided;
  return (
    <Card>
      <h3 className="font-medium">
        <span className="break-words">{request.clientName}</span> wants to use Guild Vault as you
      </h3>
      <p className="mt-2 text-sm text-zinc-400">
        {request.verifiedDomain ? (
          <>Identified by <span className="font-mono">{request.verifiedDomain}</span>.</>
        ) : (
          <>This name is self-declared: anyone can register an assistant under any name.</>
        )}{" "}
        It will act for the wallet <span className="font-mono">{shortAddress(wallet)}</span>, and you
        return to <span className="font-mono">{request.redirectHost}</span> afterwards. Only approve an
        assistant you started connecting yourself.
      </p>
      {!request.verifiedDomain && !request.redirectIsLocal && (
        <WarningText className="mt-3">
          Check that <span className="font-mono">{request.redirectHost}</span> belongs to the assistant you
          are connecting. If you did not just start this from that assistant, deny.
        </WarningText>
      )}

      <fieldset className="mt-4 space-y-3">
        <legend className="text-sm font-medium">Permissions</legend>
        {request.scopes.map((s) => (
          <label key={s.scope} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={chosen.has(s.scope)} disabled={busy}
              onChange={(e) => toggle(s.scope, e.target.checked)} />
            <span>
              <span className="font-mono text-xs text-zinc-400">{s.scope}</span>
              <span className="block">{s.description}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <p className="mt-4 text-xs text-zinc-500">
        You can disconnect it at any time under Settings. Nothing an assistant does here can vote, sign or pay.
      </p>
      <ErrorText error={decision.error} className="mt-3" />
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void decide(false)}>
          Deny
        </Button>
        <Button loading={busy} disabled={chosen.size === 0} onClick={() => void decide(true)}>
          {busy ? "Connecting…" : "Approve"}
        </Button>
      </div>
    </Card>
  );
}
