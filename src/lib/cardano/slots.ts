// Slot <-> time on the community's network (Mesh's slot configs). Server
// only: the pages read the stored `lock_until` instead.
import "server-only";

import { resolveSlotNo, SLOT_CONFIG_NETWORK, slotToBeginUnixTime } from "@meshsdk/core";
import { networkName, type Network } from "@/lib/config";

/** The slot enclosing a moment. */
export function slotAt(network: Network, ms: number): number {
  return Number(resolveSlotNo(networkName(network), ms));
}

/** The moment a slot begins, as an ISO timestamp. */
export function slotTime(network: Network, slot: number): string {
  return new Date(slotToBeginUnixTime(slot, SLOT_CONFIG_NETWORK[networkName(network)])).toISOString();
}
