// Who may manage a call: community admins and the leads of its workgroup,
// the same rule as task assignees.
import "server-only";

import { requireWorkgroupManager as requireManager } from "@/lib/authz";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { loadCall, type CallWithWorkgroup } from "@/lib/db/calls";
import { assertWorkgroupActive } from "@/lib/db/workgroups";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export async function requireWorkgroupManager(
  communityId: string,
  workgroupId: string,
  wallet: string,
): Promise<void> {
  await requireManager(communityId, workgroupId, wallet, "Only admins and workgroup leads can manage calls");
}

/** The call, for a manager about to change it. Archived workgroups are frozen. */
export async function loadCallForManager(
  callId: string,
  wallet: string,
): Promise<CallWithWorkgroup> {
  const call = await loadCall(callId);
  if (!call) throw new NotFoundError("Call not found");
  await requireWorkgroupManager(call.community_id, call.workgroup_id, wallet);
  assertWorkgroupActive(call.workgroups?.archived_at);
  return call;
}

/** A payout to the other network is refused at build time; catch it on entry. */
export function assertWalletOnCallNetwork(call: CallWithWorkgroup, wallet: string): void {
  const network = call.workgroups?.communities?.network;
  if (network !== undefined && addressToNetwork(wallet) !== network) {
    throw new BadRequestError(
      network === 1
        ? "This community pays on mainnet: use a mainnet address"
        : "This community pays on preprod: use a preprod (addr_test…) address",
    );
  }
}
