"use client";

import { use, useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CallCheckinBody } from "@/lib/api/schemas";
import type { CallCheckinResponse } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useSessionGate } from "@/hooks/useCommunityGate";
import { Button, Card, ErrorText, Field, Input, LinkButton, PageTitle } from "@/components/ui";

/**
 * Where the host's check-in link lands. Open to any signed-in wallet, not only
 * members (a private community's call can be attended by newcomers): the code
 * is the invite, and the route joins the wallet to the community.
 */
export default function CallCheckinPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = use(params);
  const { blocked } = useSessionGate();
  const [code, setCode] = useState("");
  const [result, setResult] = useState<CallCheckinResponse | null>(null);
  const action = useAsyncAction();

  // The shared link carries the code as ?code=…
  useEffect(() => {
    const fromLink = new URLSearchParams(window.location.search).get("code");
    if (fromLink) setCode(fromLink);
  }, []);

  if (blocked) return blocked;

  async function checkIn() {
    const body: CallCheckinBody = { code };
    const response = await action.run(() =>
      apiFetch<CallCheckinResponse>(`/api/calls/${id}/checkin`, { body }),
    );
    if (response) setResult(response);
  }

  return (
    <div className="max-w-lg">
      <PageTitle>Call check-in</PageTitle>
      {result ? (
        <Card>
          <p className="text-sm">
            {result.already ? "You were already checked in to" : "You are checked in to"}{" "}
            <span className="font-medium">{result.title}</span>.
          </p>
          <p className="mt-2 text-sm text-zinc-400">
            The reward is paid to the wallet you are signed in with, once the organisers
            finalize the call and run the payout.
          </p>
          <LinkButton href={routes.community(result.communitySlug || slug)} variant="secondary" className="mt-4">
            Go to the community
          </LinkButton>
        </Card>
      ) : (
        <Card>
          <p className="mb-4 text-sm text-zinc-400">
            Confirm you are in the call. Your attendance is recorded for the wallet you are
            signed in with, and that wallet receives the reward.
          </p>
          <Field label="Check-in code" hint="Shown by the host during the call.">
            <Input className="font-mono tracking-[0.3em] uppercase" value={code} maxLength={32} autoComplete="off"
              spellCheck={false} onChange={(e) => setCode(e.target.value)} />
          </Field>
          <ErrorText error={action.error} className="mt-3" />
          <Button className="mt-4" disabled={!code.trim()} loading={action.busy} onClick={() => void checkIn()}>
            {action.busy ? "Checking in…" : "Check in"}
          </Button>
        </Card>
      )}
    </div>
  );
}
