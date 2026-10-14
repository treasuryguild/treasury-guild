"use client";

// Where an AI assistant (claude.ai, Claude Desktop, Claude Code…) sends the
// user to approve a connection: sign in with the wallet, then approve or deny.

import { useSessionGate } from "@/hooks/useCommunityGate";
import { useConsentRequest } from "@/hooks/useConsentRequest";
import { Card, ErrorText, PageMessage, PageTitle } from "@/components/ui";
import { ConsentCard } from "@/components/oauth/ConsentCard";
import { consentErrorMessage } from "@/lib/oauthServer/consentErrors";

export default function ConsentPage() {
  const { sessionWallet, blocked } = useSessionGate();
  const { handle, refusal, ready, info } = useConsentRequest();

  let body;
  if (!ready) {
    body = null;
  } else if (refusal) {
    body = (
      <Card>
        {/* A fixed sentence per code: the query string is attacker-chosen. */}
        <p>The assistant&apos;s request could not be accepted: {consentErrorMessage(refusal)}.</p>
        <p className="mt-2 text-sm text-zinc-400">Start connecting again from the assistant.</p>
      </Card>
    );
  } else if (!handle) {
    body = <PageMessage>Nothing to approve here. Start connecting from your AI assistant.</PageMessage>;
  } else if (blocked) {
    body = blocked;
  } else if (info.error) {
    body = <ErrorText error={info.error} />;
  } else if (info.data) {
    body = <ConsentCard handle={handle} request={info.data} wallet={sessionWallet!} />;
  } else {
    body = null;
  }

  return (
    <div className="max-w-xl space-y-4">
      <PageTitle>Connect an AI assistant</PageTitle>
      {body}
    </div>
  );
}
