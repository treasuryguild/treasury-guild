// Resolve an optional "start monitoring after" Cardano tx for a float wallet.
import type { KoiosTxInfo } from "@/lib/cardano/koios";

/** True when the Shelley address appears on an input or output of the tx. */
export function txTouchesAddress(info: KoiosTxInfo, address: string): boolean {
  for (const input of info.inputs) {
    if (input.payment_addr?.bech32 === address) return true;
  }
  for (const output of info.outputs) {
    if (output.payment_addr?.bech32 === address) return true;
  }
  return false;
}
