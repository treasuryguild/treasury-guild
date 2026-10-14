"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftRight, LogOut, Settings2, Unplug, WalletCards } from "lucide-react";
import { useWalletBridge } from "@/components/providers/WalletBridge";
import { useSession } from "@/hooks/useSession";
import { NetworkBadge } from "@/components/community/NetworkNotice";
import { Button } from "@/components/ui";
import { shortAddress } from "@/lib/format";
import { routes } from "@/lib/routes";

/** Button that opens the list of installed CIP-30 wallets. */
function WalletPicker({
  label,
  shortLabel,
  variant = "primary",
  onPick,
}: {
  label: ReactNode;
  shortLabel: ReactNode;
  variant?: "primary" | "secondary";
  onPick: (walletId: string) => void;
}) {
  const { walletList, ready } = useWalletBridge();
  const { connecting } = useSession();
  const [picking, setPicking] = useState(false);

  return (
    <div className="relative">
      <Button
        variant={variant}
        className="gap-2 px-3 sm:px-4"
        loading={connecting}
        onClick={() => setPicking((v) => !v)}
      >
        {!connecting && <WalletCards className="h-4 w-4" />}
        <span className="hidden sm:inline">{connecting ? "Connecting…" : label}</span>
        <span className="sm:hidden">{connecting ? "Connecting…" : shortLabel}</span>
      </Button>
      {picking && !connecting && (
        <div className="glass-menu absolute right-0 z-30 mt-2 w-56 rounded-2xl p-2">
          {!ready && <p className="p-2 text-sm text-zinc-400">Detecting wallets…</p>}
          {ready && walletList.length === 0 && (
            <p className="p-2 text-sm text-zinc-400">
              No CIP-30 wallets found. Install Eternl or Lace.
            </p>
          )}
          {walletList.map((w) => (
            <button
              key={w.id}
              className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800"
              onClick={() => {
                onPick(w.id);
                setPicking(false);
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={w.icon} alt="" className="h-5 w-5" />
              {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function WalletBar() {
  const { connect, disconnect, name } = useWalletBridge();
  const {
    connected,
    sessionWallet,
    walletNetwork,
    walletAddress,
    walletMismatch,
    loading,
    signingIn,
    error,
    connectAndSignIn,
    signIn,
    signOut,
  } = useSession();

  if (loading) return <div className="h-9" />;

  if (sessionWallet) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        {/* Signed in (cookie) but the CIP-30 connection was not restored —
            e.g. the wallet declined the silent re-enable, or was locked.
            Signing needs the wallet, so offer to reconnect without ending
            the session. */}
        {!connected && (
          <WalletPicker
            label="Reconnect wallet"
            shortLabel="Reconnect"
            variant="secondary"
            onPick={(id) => void connect(id)}
          />
        )}
        {/* The wallet extension switched to another account: the session is
            still the old address and the server would reject its signatures.
            One click re-signs in as the connected account. */}
        {walletMismatch && walletAddress && (
          <>
            {error && <span className="hidden text-xs text-red-400 lg:inline">{error}</span>}
            <Button
              className="gap-2 px-3 sm:px-4"
              loading={signingIn}
              onClick={() => void signIn()}
              title={`Sign in as ${walletAddress}`}
            >
              {!signingIn && <ArrowLeftRight className="h-4 w-4" />}
              <span className="hidden sm:inline">
                {signingIn
                  ? "Signing in… check your wallet"
                  : `Switch account to ${shortAddress(walletAddress)}`}
              </span>
              <span className="sm:hidden">{signingIn ? "Check wallet…" : "Switch account"}</span>
            </Button>
          </>
        )}
        {/* The wallet decides which communities the user can act in. */}
        {walletNetwork !== null && <NetworkBadge network={walletNetwork} />}
        <Link
          href={routes.settings()}
          className="inline-flex min-h-10 items-center gap-2 rounded-xl border border-transparent px-2 text-xs text-zinc-400 transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-soft)] hover:text-zinc-200"
          title="Profile & settings"
          aria-label="Profile and settings"
        >
          <Settings2 className="h-4 w-4 shrink-0" />
          <span className="hidden font-mono xl:inline">
            {shortAddress(sessionWallet)}
          </span>
        </Link>
        <Button
          variant="secondary"
          className="gap-2 px-3 sm:px-4"
          title="Sign out"
          onClick={() => {
            void signOut();
            disconnect();
          }}
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">Sign out</span>
        </Button>
      </div>
    );
  }

  if (!connected) {
    return (
      <WalletPicker
        label="Connect wallet"
        shortLabel="Connect"
        // Connect and sign in with one click; the sign-in fires as soon as
        // the wallet bridge is ready (SessionProvider).
        onPick={(id) => void connectAndSignIn(id)}
      />
    );
  }

  // Connected but not signed in: the manual button is the fallback for a
  // declined or failed automatic sign-in.
  return (
    <div className="flex min-w-0 items-center gap-2">
      {error && <span className="hidden text-xs text-red-400 lg:inline">{error}</span>}
      <Button className="gap-2 px-3 sm:px-4" loading={signingIn} onClick={() => void signIn()}>
        {!signingIn && <WalletCards className="h-4 w-4" />}
        <span className="hidden sm:inline">
          {signingIn ? "Signing in… check your wallet" : `Sign in with ${name}`}
        </span>
        <span className="sm:hidden">{signingIn ? "Check wallet…" : "Sign in"}</span>
      </Button>
      <Button
        className="px-3"
        variant="ghost"
        onClick={() => disconnect()}
        disabled={signingIn}
        title="Disconnect wallet"
      >
        <Unplug className="h-4 w-4" />
        <span className="sr-only">Disconnect</span>
      </Button>
    </div>
  );
}
