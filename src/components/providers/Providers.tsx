"use client";

import type { ReactNode } from "react";
import { SessionProvider } from "./SessionProvider";
import { WalletBridgeProvider } from "./WalletBridge";

// Neither provider imports @meshsdk at the value level, so the root layout
// server-renders and the eager bundle stays small. The Mesh stack loads
// client-side inside WalletBridgeProvider and feeds SessionProvider through
// context.
export function Providers({ children }: { children: ReactNode }) {
  return (
    <WalletBridgeProvider>
      <SessionProvider>{children}</SessionProvider>
    </WalletBridgeProvider>
  );
}
