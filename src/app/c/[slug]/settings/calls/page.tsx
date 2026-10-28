"use client";

import { use } from "react";
import Link from "next/link";
import { routes } from "@/lib/routes";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { IntegrationCard } from "@/components/calls/IntegrationCard";
import { LinkedMeetingsCard } from "@/components/calls/LinkedMeetingsCard";
import { PageTitle } from "@/components/ui";

export default function CallSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  if (blocked) return blocked;

  const returnTo = routes.callSettings(slug);
  return (
    <div className="max-w-2xl space-y-4">
      <PageTitle>Call platforms</PageTitle>
      <p className="-mt-3 mb-2 text-sm text-zinc-400">
        Connect Zoom or Google Meet so attendance is captured while a call runs. Check-in and pasted
        lists on the Calls page work without any connection. Discord voice capture needs the server
        under{" "}
        <Link className="text-indigo-400 hover:underline" href={routes.integrations(slug)}>
          Integrations
        </Link>
        .
      </p>

      <IntegrationCard
        communityId={community!.id}
        provider="zoom"
        title="Zoom account"
        apiPath="/api/zoom/connect"
        outcomeParam="zoom"
        returnTo={returnTo}
        nouns={{ thing: "account", connect: "Connect Zoom account", change: "Change account" }}
        blurb={<>
          Connect the Zoom account that hosts your community&apos;s calls. Zoom then tells Guild
          Vault who joins and leaves its meetings, and how long they stayed; only the meetings
          you list as calls, or link below, become visible to members. Only meetings hosted by this account can be captured, so use one shared account.
        </>}
        footnote={<>
          Zoom attendees are mostly guests known by the name they typed: a name that matches a
          member, or one you linked before, arrives with its wallet, the rest wait for one. The
          final minutes come from Zoom&apos;s participant report, which needs a paid Zoom plan; on a
          free plan the live join and leave events still count.
        </>}
        disconnectWarning={<>
          Capture stops for this community&apos;s Zoom calls and the stored access is deleted.
          Attendees already captured stay on their calls.
        </>}
      />

      <LinkedMeetingsCard communityId={community!.id} />

      <IntegrationCard
        communityId={community!.id}
        provider="google"
        title="Google Meet account"
        apiPath="/api/google/host-connect"
        outcomeParam="google_host"
        returnTo={returnTo}
        nouns={{ thing: "account", connect: "Connect Google account", change: "Change account" }}
        blurb={<>
          Connect the Google account that creates your community&apos;s Meet calls. Treasury Guild
          then reads who attended the meetings you list on the Calls page, and for how long. It
          asks for one permission, reading your meetings&apos; attendance: no audio, video, chat,
          recordings or calendar. Meet only reports a meeting to the account that created it, so
          create rewarded calls from this one account.
        </>}
        footnote={<>
          Tick the Meet permission on Google&apos;s screen, or the connection is refused
          (meet_permission_not_granted). Attendees signed in to Google are recognised by the
          Google account they linked on their Profile page; guests show up by name, waiting for a
          wallet.
        </>}
        disconnectWarning={<>
          Capture stops for this community&apos;s Meet calls, the stored access is deleted and
          revoked at Google. Attendees already captured stay on their calls.
        </>}
      />
    </div>
  );
}
