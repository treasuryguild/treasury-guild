"use client";

// Mesh-free wallet state for the whole tree. The heavy Mesh stack
// (@meshsdk/react + @meshsdk/core, tens of MB) is loaded by MeshBridge as a
// *sibling* of the page tree, client-side only, and publishes its state here.
// That keeps the root layout server-renderable and out of the eager bundle,
// and never remounts the page when Mesh finishes loading.
import dynamic from "next/dynamic";
import { createContext, useContext, useState, type ReactNode } from "react";
import type { IWallet } from "@meshsdk/core";

export interface WalletOption {
  id: string;
  name: string;
  icon: string;
}

export interface WalletBridgeState {
  /** Mesh has loaded; `walletList` and `connect` are live. */
  ready: boolean;
  /** 1.9 IWallet bridged from the connected CIP-30 wallet (see useMeshWallet). */
  wallet: IWallet | null;
  connected: boolean;
  /** The CIP-30 connect prompt is open. */
  connecting: boolean;
  name: string | undefined;
  walletList: WalletOption[];
  connect: (walletId: string) => Promise<void>;
  disconnect: () => void;
}

const NOT_READY: WalletBridgeState = {
  ready: false,
  wallet: null,
  connected: false,
  connecting: false,
  name: undefined,
  walletList: [],
  connect: async () => undefined,
  disconnect: () => undefined,
};

const WalletBridgeContext = createContext<WalletBridgeState>(NOT_READY);

const LazyMeshBridge = dynamic(() => import("./MeshBridge"), { ssr: false });

export function WalletBridgeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletBridgeState>(NOT_READY);
  return (
    <WalletBridgeContext.Provider value={state}>
      {children}
      <LazyMeshBridge onState={setState} />
    </WalletBridgeContext.Provider>
  );
}

export function useWalletBridge(): WalletBridgeState {
  return useContext(WalletBridgeContext);
}
