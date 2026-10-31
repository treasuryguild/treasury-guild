"use client";

// Bridges @meshsdk/react 2.0's connection state to a @meshsdk/core 1.9 IWallet.
// react 2.0's useWallet().wallet swaps signData's arguments
// (signData(address, payload) vs 1.9's signData(payload, address)) — both are
// strings, so a wrong-order call compiles but signs the wrong bytes. Re-enabling
// through the 1.9 BrowserWallet restores the exact surface the signing code expects.
//
// CIP-95 must be on this enable call: getDRep() needs walletInstance.cip95, and
// react 2.0's MeshCardanoBrowserWallet no longer exposes getDRep. A prior
// connect that omitted CIP-95 can leave Eternl returning an API without cip95
// on later enables — then getDRep is empty until the user disconnects this
// site in the wallet and connects again (MeshBridge always requests CIP-95).
//
// @meshsdk/core is imported dynamically: a static value import would hoist the
// whole Cardano serialization stack into whichever chunk includes this hook.
import { useEffect, useState } from "react";
import type { IWallet } from "@meshsdk/core";
import { useWallet } from "@meshsdk/react";

export function useMeshWallet() {
  const { name, connected } = useWallet();
  const [wallet, setWallet] = useState<IWallet | null>(null);

  useEffect(() => {
    let cancelled = false;
    const pending: Promise<IWallet | null> =
      connected && name
        ? import("@meshsdk/core").then(async ({ BrowserWallet }) => {
            // Prefer CIP-95. Do not fall back to a plain enable on
            // success-without-cip95: that is the stale-session case and plain
            // enable only makes DRep worse.
            try {
              return await BrowserWallet.enable(name, [{ cip: 95 }]);
            } catch {
              try {
                return await BrowserWallet.enable(name);
              } catch {
                return null;
              }
            }
          })
        : Promise.resolve(null);
    void pending.then((w) => {
      if (!cancelled) setWallet(w);
    });
    return () => {
      cancelled = true;
    };
  }, [connected, name]);

  return { wallet, connected, name };
}
