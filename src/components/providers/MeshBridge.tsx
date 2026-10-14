"use client";

// The only module that imports @meshsdk/react. Loaded lazily (client-only) by
// WalletBridgeProvider; renders nothing and pushes Mesh's connection state up
// into WalletBridgeContext.
import { useCallback, useEffect, useRef } from "react";
import { MeshProvider, useWallet, useWalletList } from "@meshsdk/react";
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

function Inner({ onState }: { onState: OnState }) {
  const list = useWalletList();
  const { connect, disconnect, connecting, setPersist } = useWallet();
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
  useEffect(() => {
    connectRef.current = connect;
    disconnectRef.current = disconnect;
  }, [connect, disconnect]);
  const connectStable = useCallback((id: string) => connectRef.current(id, true), []);
  const disconnectStable = useCallback(() => disconnectRef.current(), []);

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
