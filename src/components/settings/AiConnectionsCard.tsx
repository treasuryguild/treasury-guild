"use client";

// The AI assistants this wallet approved (through the consent page), with a
// Disconnect each: the grant goes and the assistant loses access on its very
// next request.

import { apiFetch } from "@/lib/api/client";
import type { OAuthConnectionsResponse } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, Card, ErrorText } from "@/components/ui";

export function AiConnectionsCard({ wallet }: { wallet: string }) {
  const connections = useAsyncData(wallet, () => apiFetch<OAuthConnectionsResponse>("/api/oauth/connections"));
  const disconnect = useAsyncAction("Could not disconnect the assistant");

  async function remove(clientId: string) {
    const ok = await disconnect.run(() =>
      apiFetch("/api/oauth/connections", { method: "DELETE", query: { clientId } }),
    );
    if (ok) connections.reload();
  }

  const list = connections.data?.connections ?? [];
  return (
    <Card>
      <h3 className="font-medium">🤖 AI assistants</h3>
      <p className="mt-1 text-sm text-zinc-400">
        Assistants such as Claude can read your communities, treasuries, tasks, budgets and proposals once you approve
        them. With a write permission you ticked, they can also prepare changes you confirm in the conversation. They
        can never sign, submit, pay or vote.{" "}
        <a className="underline" href={routes.doc("ai-assistants")}>How to connect one</a>
      </p>
      <ErrorText error={connections.error ?? disconnect.error} className="mt-3" />
      {list.length === 0 ? (
        !connections.loading && <p className="mt-3 text-sm text-zinc-500">No assistant is connected.</p>
      ) : (
        <ul className="mt-3 space-y-3">
          {list.map((c) => (
            <li key={c.clientId} className="flex min-w-0 flex-wrap items-center gap-3">
              <span className="min-w-0 flex-1 break-words text-sm">
                {c.clientName}{" "}
                <span className="text-xs text-zinc-500">
                  since {formatDate(c.connectedAt)}
                  {c.lastUsedAt ? `, last used ${formatDate(c.lastUsedAt)}` : ""}
                </span>
              </span>
              <Button variant="secondary" disabled={disconnect.busy} onClick={() => void remove(c.clientId)}>
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
