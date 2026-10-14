// contributor_identities writes (service role only): the Discord / Google
// account a wallet proved through OAuth. Only the wallet itself reads its rows
// (RLS); everything else resolves identities here.
import "server-only";

import { AttendeeSource, CallState, IdentityProvider, PgCode } from "@/lib/constants";
import { check, rows, serviceClient } from "./client";

/** The attendee rows an identity shows up as: Meet reports carry the Google account. */
const ATTENDEE_SOURCE: Record<IdentityProvider, AttendeeSource> = {
  [IdentityProvider.Discord]: AttendeeSource.Discord,
  [IdentityProvider.Google]: AttendeeSource.Meet,
};

export type LinkIdentityResult = "linked" | "taken";

/**
 * Link the account to the wallet, replacing the wallet's previous account of
 * that provider. "taken" when the account already belongs to another wallet.
 */
export async function linkIdentity(identity: {
  wallet: string;
  provider: IdentityProvider;
  externalId: string;
  displayName: string | null;
}): Promise<LinkIdentityResult> {
  const { error } = await serviceClient()
    .from("contributor_identities")
    .upsert(
      {
        wallet_address: identity.wallet,
        provider: identity.provider,
        external_id: identity.externalId,
        display_name: identity.displayName,
        verified_at: new Date().toISOString(),
      },
      { onConflict: "wallet_address,provider" },
    );
  // unique (provider, external_id): another wallet holds this account.
  if (error?.code === PgCode.UniqueViolation) return "taken";
  check({ error }, "link identity");
  return "linked";
}

export async function unlinkIdentity(wallet: string, provider: IdentityProvider): Promise<void> {
  check(
    await serviceClient()
      .from("contributor_identities")
      .delete()
      .eq("wallet_address", wallet)
      .eq("provider", provider),
    "unlink identity",
  );
}

/** Wallet per linked account, for the accounts among `externalIds` that are linked. */
export async function loadWalletsByIdentity(
  provider: IdentityProvider,
  externalIds: readonly string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(externalIds)];
  if (distinct.length === 0) return new Map();
  const found = rows<{ external_id: string; wallet_address: string }>(
    await serviceClient()
      .from("contributor_identities")
      .select("external_id, wallet_address")
      .eq("provider", provider)
      .in("external_id", distinct),
    "load wallets by identity",
  );
  return new Map(found.map((i) => [i.external_id, i.wallet_address]));
}

/**
 * Link backfill: captured attendees of this account that are still waiting
 * for a wallet get it, on open calls of active workgroups only, never where
 * the call already lists the wallet (one reward per wallet per call) and never
 * on a row that is already on a task. Returns the number of rows filled.
 */
export async function fillAttendeeWalletsByIdentity(
  provider: IdentityProvider,
  externalId: string,
  wallet: string,
): Promise<number> {
  const db = serviceClient();
  const candidates = rows<{
    id: string;
    call_id: string;
    calls: { state: string; workgroups: { archived_at: string | null } | null } | null;
  }>(
    await db
      .from("call_attendees")
      .select("id, call_id, calls!inner(state, workgroups!inner(archived_at))")
      .eq("provider", ATTENDEE_SOURCE[provider])
      .eq("external_id", externalId)
      .is("wallet_address", null)
      .is("task_id", null),
    "load unlinked attendee rows",
  );
  const open = candidates.filter(
    (c) => c.calls?.state === CallState.Open && !c.calls.workgroups?.archived_at,
  );
  if (open.length === 0) return 0;

  const taken = new Set(
    rows<{ call_id: string }>(
      await db
        .from("call_attendees")
        .select("call_id")
        .in("call_id", [...new Set(open.map((c) => c.call_id))])
        .eq("wallet_address", wallet),
      "load calls already listing wallet",
    ).map((r) => r.call_id),
  );
  const ids = open.filter((c) => !taken.has(c.call_id)).map((c) => c.id);
  if (ids.length === 0) return 0;
  check(
    await db.from("call_attendees").update({ wallet_address: wallet }).in("id", ids),
    "backfill attendee wallets",
  );
  return ids.length;
}
