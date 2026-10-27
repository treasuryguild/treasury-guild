"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { CreateCommunityResponse } from "@/lib/api/types";
import { appNetwork, type Network, networkName } from "@/lib/config";
import { Visibility } from "@/lib/constants";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useSession } from "@/hooks/useSession";
import {
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  PageTitle,
  Textarea,
} from "@/components/ui";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const NETWORK_OPTIONS: { value: Network; title: string; blurb: string }[] = [
  {
    value: 1,
    title: "Mainnet",
    blurb: "Real ADA and tokens. For a community that is ready to pay contributors.",
  },
  {
    value: 0,
    title: "Preprod testnet",
    blurb:
      "Test ADA only (free from the faucet). Try the whole flow without risking funds; connect a wallet set to preprod.",
  },
];

const VISIBILITY_OPTIONS: { value: Visibility; title: string; blurb: string }[] = [
  {
    value: Visibility.Private,
    title: "Private",
    blurb:
      "Invite-only. Members are added by an admin, via GitHub assignments, or call check-in.",
  },
  {
    value: Visibility.Public,
    title: "Public",
    blurb: "Listed on Discover; anyone signed in can join as a member.",
  },
];

export default function NewCommunity() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<Visibility>(Visibility.Private);
  const { walletNetwork } = useSession();
  // Preselect the wallet's network (the deployment default until it is
  // known); an explicit pick by the user is never overridden.
  const [network, setNetwork] = useState<Network>(() => appNetwork());
  const picked = useRef(false);
  useEffect(() => {
    if (walletNetwork !== null && !picked.current) setNetwork(walletNetwork);
  }, [walletNetwork]);
  const { run, busy, error } = useAsyncAction("Failed to create community");

  async function submit() {
    const result = await run(() =>
      apiFetch<CreateCommunityResponse>("/api/community", {
        body: { name, slug, description, network, visibility },
      }),
    );
    if (result) router.push(routes.community(result.community.slug));
  }

  return (
    <div className="mx-auto max-w-lg">
      <PageTitle>New community</PageTitle>
      <Card className="space-y-4">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setSlug(slugify(e.target.value));
            }}
            placeholder="My DAO"
          />
        </Field>
        <Field label="Slug (URL, used in on-chain metadata)">
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="my-dao"
          />
        </Field>
        <Field label="Description">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </Field>
        <Field
          label="Cardano network"
          hint="Chosen once: the community's wallets and payment history live on this network."
        >
          <div className="flex flex-col gap-1.5">
            {NETWORK_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400"
              >
                <input
                  type="radio"
                  name="network"
                  className="mt-0.5"
                  checked={network === option.value}
                  onChange={() => {
                    picked.current = true;
                    setNetwork(option.value);
                  }}
                />
                <span>
                  <span className="text-zinc-200">{option.title}</span> — {option.blurb}
                </span>
              </label>
            ))}
          </div>
        </Field>
        {walletNetwork !== null && network !== walletNetwork && (
          <p className="text-xs text-amber-500">
            Your wallet is currently on {networkName(walletNetwork)}. You
            can create this community, but you will need a{" "}
            {networkName(network)} account to run its treasury.
          </p>
        )}
        <Field
          label="Visibility"
          hint="You can change this later on the Members page."
        >
          <div className="flex flex-col gap-1.5">
            {VISIBILITY_OPTIONS.map((option) => (
              <label
                key={option.value}
                className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400"
              >
                <input
                  type="radio"
                  name="visibility"
                  className="mt-0.5"
                  checked={visibility === option.value}
                  onChange={() => setVisibility(option.value)}
                />
                <span>
                  <span className="text-zinc-200">{option.title}</span> — {option.blurb}
                </span>
              </label>
            ))}
          </div>
        </Field>
        <ErrorText error={error} />
        <Button onClick={() => void submit()} disabled={!name || !slug} loading={busy}>
          {busy ? "Creating…" : "Create community"}
        </Button>
      </Card>
    </div>
  );
}
