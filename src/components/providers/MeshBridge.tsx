"use client";

// The only module that imports @meshsdk/react. Loaded lazily (client-only) by
// WalletBridgeProvider; renders nothing and pushes Mesh's connection state up
// into WalletBridgeContext.
import { useCallback, useEffect, useRef } from "react";
import {
  MeshCardanoBrowserWallet,
  MeshProvider,
  useWallet,
  useWalletList,
} from "@meshsdk/react";
import { useMeshWallet } from "@/hooks/useMeshWallet";
import type { WalletBridgeState } from "./WalletBridge";

type OnState = (state: WalletBridgeState) => void;

function sameList(a: WalletBridgeState["walletList"], b: WalletBridgeState["walletList"]) {
  return (
    a.length === b.length &&
    a.every((w, i) => {
      const o = b[i];
      return o !== undefined && w.id === o.id && w.name === o.name && w.icon === o.icon;
    })
  );
}

/** Always include CIP-95 so the first CIP-30 grant can expose getPubDRepKey. */
function extensionsWithCip95(walletId: string): { cip: number }[] {
  const cardano = (globalThis as { cardano?: Record<string, { supportedExtensions?: { cip: number }[] }> })
    .cardano;
  const supported = cardano?.[walletId]?.supportedExtensions ?? [];
  return [...supported.filter((e) => e.cip !== 95), { cip: 95 }];
}

function Inner({ onState }: { onState: OnState }) {
  const list = useWalletList();
  const { connect, disconnect, connecting, setPersist, setWallet } = useWallet();
  const { wallet, connected, name } = useMeshWallet();

  // The session lives in a cookie and survives a reload; the CIP-30
  // connection does not unless Mesh is told to remember it. `persist` on
  // connect stores the wallet name in localStorage and `setPersist(true)`
  // makes MeshProvider re-enable it on load (Mesh's own CardanoWallet
  // button does the same). Without this a reloaded page is signed in but
  // has no wallet to sign with. `disconnect` clears the stored name.
  useEffect(() => {
    setPersist(true);
  }, [setPersist]);

  // Stable callbacks so state pushes are driven by values, not by Mesh
  // handing out new function identities on re-render.
  const connectRef = useRef(connect);
  const disconnectRef = useRef(disconnect);
  const setWalletRef = useRef(setWallet);
  useEffect(() => {
    connectRef.current = connect;
    disconnectRef.current = disconnect;
    setWalletRef.current = setWallet;
  }, [connect, disconnect, setWallet]);

  // Mesh's stock connectWallet only passes window.cardano[id].supportedExtensions,
  // which is sometimes empty at click time — then CIP-95 is never requested and
  // later enables keep returning an API without cip95. Enable ourselves with
  // CIP-95 forced, then inject into Mesh via setWallet.
  const connectStable = useCallback(async (id: string) => {
    try {
      const instance = await MeshCardanoBrowserWallet.enable(id, extensionsWithCip95(id));
      setWalletRef.current(instance, id, {});
    } catch {
      await connectRef.current(id, true);
    }
  }, []);
  const disconnectStable = useCallback(() => disconnectRef.current(), []);

  // MeshProvider's persist restore calls its own connectWallet (supportedExtensions
  // only). Re-enable with CIP-95 forced so a reload still grants getPubDRepKey
  // when the wallet will negotiate it.
  const cip95Upgrade = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || !name) {
      if (!connected) cip95Upgrade.current = null;
      return;
    }
    if (cip95Upgrade.current === name) return;
    cip95Upgrade.current = name;
    void (async () => {
      try {
        const instance = await MeshCardanoBrowserWallet.enable(name, extensionsWithCip95(name));
        setWalletRef.current(instance, name, {});
      } catch {
        // Keep the existing Mesh connection (signing still works).
      }
    })();
  }, [connected, name]);

  const last = useRef<WalletBridgeState | null>(null);
  useEffect(() => {
    const walletList = list.map((w) => ({ id: w.id, name: w.name, icon: w.icon }));
    const prev = last.current;
    if (
      prev &&
      prev.wallet === wallet &&
      prev.connected === connected &&
      prev.connecting === connecting &&
      prev.name === name &&
      sameList(prev.walletList, walletList)
    ) {
      return;
    }
    const next: WalletBridgeState = {
      ready: true,
      wallet,
      connected,
      connecting,
      name,
      walletList,
      connect: connectStable,
      disconnect: disconnectStable,
    };
    last.current = next;
    onState(next);
  }, [list, wallet, connected, connecting, name, connectStable, disconnectStable, onState]);

  return null;
}

export default function MeshBridge({ onState }: { onState: OnState }) {
  return (
    <MeshProvider>
      <Inner onState={onState} />
    </MeshProvider>
  );
}
