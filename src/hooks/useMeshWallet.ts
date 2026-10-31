"use client";

// Bridges @meshsdk/react 2.0's connection state to a @meshsdk/core 1.9 IWallet.
// react 2.0's useWallet().wallet swaps signData's arguments
// (signData(address, payload) vs 1.9's signData(payload, address)) — both are
// strings, so a wrong-order call compiles but signs the wrong bytes. Re-enabling
// through the 1.9 BrowserWallet restores the exact surface the signing code expects.
//
// CIP-95 is requested so getDRep() can return a DRep key hash for SDK signer
// invites and treasury create. Wallets that refuse the extension fall back to a
// plain enable so connect and signing still work (stake only; no DRep hash).
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
        ? import("@meshsdk/core")
            .then(({ BrowserWallet }) =>
              BrowserWallet.enable(name, [{ cip: 95 }]).catch(() =>
                BrowserWallet.enable(name),
              ),
            )
            .catch(() => null)
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
