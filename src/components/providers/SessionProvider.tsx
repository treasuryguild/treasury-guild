"use client";

// Single shared session state: every useSession() consumer reads the same
// context, so signing in via the header updates the whole page tree at once.
import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { IWallet } from "@meshsdk/core";
import { apiFetch, describeApiError } from "@/lib/api/client";
import type {
  AuthNonceResponse,
  AuthVerifyResponse,
  SessionTokenResponse,
} from "@/lib/api/types";
import { asNetwork, type Network } from "@/lib/config";
import { MSG } from "@/lib/constants";
import { routes } from "@/lib/routes";
import { setBrowserToken } from "@/lib/supabase/browser";
import { useWalletBridge } from "./WalletBridge";

export interface SessionContextValue {
  wallet: IWallet | null;
  /**
   * Network the connected wallet is set to (CIP-30 getNetworkId: 0 = a
   * testnet, 1 = mainnet); null while disconnected or resolving. Communities
   * pick their own network, so the UI follows the wallet's.
   */
  walletNetwork: Network | null;
  /**
   * Address of the connected wallet's current account (same derivation the
   * sign-in uses); null while disconnected or resolving.
   */
  walletAddress: string | null;
  /**
   * The connected wallet's account is not the one the session was signed in
   * with — the user switched accounts in the wallet extension. Signing would
   * be rejected by the server; `signIn` re-signs as the connected account.
   */
  walletMismatch: boolean;
  connected: boolean;
  /** The CIP-30 connect prompt is open. */
  connecting: boolean;
  sessionWallet: string | null;
  /** The session wallet may use the internal /dev tools (DEV_WALLETS). */
  developer: boolean;
  loading: boolean;
  signingIn: boolean;
  error: string | null;
  /** Connect a CIP-30 wallet and sign in with it in one go. */
  connectAndSignIn: (walletId: string) => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}

export const SessionContext = createContext<SessionContextValue | null>(null);

/** The address a wallet signs in as: first used address, else the change address. */
async function resolveWalletAddress(wallet: IWallet): Promise<string> {
  const usedAddresses = await wallet.getUsedAddresses();
  return usedAddresses[0] ?? (await wallet.getChangeAddress());
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Wallet state arrives from the lazily loaded Mesh bridge (WalletBridge);
  // this provider itself stays free of @meshsdk so the shell can server-render.
  const { wallet, connected, connecting, connect } = useWalletBridge();
  const [sessionWallet, setSessionWallet] = useState<string | null>(null);
  const [developer, setDeveloper] = useState(false);
  const [loading, setLoading] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set by connectAndSignIn; consumed (once) when the bridged wallet is ready.
  // A ref, not state: it must not re-trigger sign-in on unrelated re-renders,
  // and a rejected signature must leave the manual "Sign in" as the fallback.
  const autoSignIn = useRef(false);
  const [walletNetwork, setWalletNetwork] = useState<Network | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);

  // Network and address of the connected account. Re-resolved whenever the
  // bridged wallet changes (connect, reconnect after reload); a wallet
  // extension switching accounts without a reconnect is picked up on the
  // next reload, when the persisted connection is restored.
  useEffect(() => {
    if (!wallet) {
      setWalletNetwork(null);
      setWalletAddress(null);
      return;
    }
    let cancelled = false;
    wallet
      .getNetworkId()
      .then((id) => {
        if (!cancelled) setWalletNetwork(asNetwork(id));
      })
      .catch(() => {
        if (!cancelled) setWalletNetwork(null);
      });
    resolveWalletAddress(wallet)
      .then((address) => {
        if (!cancelled) setWalletAddress(address);
      })
      .catch(() => {
        if (!cancelled) setWalletAddress(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wallet]);

  const refresh = useCallback(async () => {
    try {
      const { wallet: w, token, developer: dev } =
        await apiFetch<SessionTokenResponse>("/api/auth/token");
      // Seed the browser Supabase client so its queries don't each re-fetch it.
      setBrowserToken(token);
      setSessionWallet(w);
      setDeveloper(dev);
    } catch {
      setBrowserToken(null);
      setSessionWallet(null);
      setDeveloper(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const signIn = useCallback(async () => {
    if (!wallet) {
      setError(MSG.connectWallet);
      return;
    }
    setSigningIn(true);
    setError(null);
    try {
      const address = await resolveWalletAddress(wallet);
      const { nonce } = await apiFetch<AuthNonceResponse>("/api/auth/nonce", {
        body: { address },
      });
      // 1.9 IWallet signature: signData(payload, address)
      const { key, signature } = await wallet.signData(nonce, address);
      const { firstLogin } = await apiFetch<AuthVerifyResponse>("/api/auth/verify", {
        body: { address, nonce, key, signature },
      });
      await refresh();
      // First-ever sign-in from this wallet: start onboarding.
      if (firstLogin) router.push(routes.welcome());
    } catch (err) {
      setError(describeApiError(err, "Sign-in failed"));
    } finally {
      setSigningIn(false);
    }
  }, [wallet, refresh, router]);

  const connectAndSignIn = useCallback(
    async (walletId: string) => {
      setError(null);
      autoSignIn.current = true;
      await connect(walletId);
    },
    [connect],
  );

  // The 1.9 wallet bridge (useMeshWallet) enables asynchronously after
  // connect() resolves, so the sign-in has to wait for `wallet` here. The
  // flag is only consumed here (or dropped by signOut): a declined connect
  // leaves it set so the next successful connect still signs in.
  useEffect(() => {
    if (!autoSignIn.current || !wallet || sessionWallet || loading || signingIn) return;
    autoSignIn.current = false;
    void signIn();
  }, [wallet, sessionWallet, loading, signingIn, signIn]);

  const signOut = useCallback(async () => {
    autoSignIn.current = false;
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    setBrowserToken(null);
    setSessionWallet(null);
    setDeveloper(false);
  }, []);

  const walletMismatch =
    sessionWallet !== null && walletAddress !== null && walletAddress !== sessionWallet;

  return (
    <SessionContext.Provider
      value={{
        wallet,
        walletNetwork,
        walletAddress,
        walletMismatch,
        connected,
        connecting,
        sessionWallet,
        developer,
        loading,
        signingIn,
        error,
        connectAndSignIn,
        signIn,
        signOut,
      }}
    >
      {children}
    </SessionContext.Provider>
  );
}
