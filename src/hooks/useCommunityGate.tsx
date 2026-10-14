"use client";

// Access gates for pages. Usage:
//   const { community, blocked } = useCommunityGate(slug, { require: "admin" });
//   ...other hooks...
//   if (blocked) return blocked;
import type { ReactElement } from "react";
import { PageMessage } from "@/components/ui";
import {
  communityGate,
  devGate,
  sessionGate,
  type GateDecision,
  type GateRequirement,
} from "@/lib/gate";
import { useCommunity, type CommunityState } from "./useCommunity";
import { useSession } from "./useSession";

function render(decision: GateDecision): ReactElement | null {
  if (decision.kind === "loading") return <></>;
  if (decision.kind === "blocked") {
    return <PageMessage>{decision.message}</PageMessage>;
  }
  return null;
}

export function useCommunityGate(
  slug: string,
  opts: { require?: GateRequirement } = {},
): CommunityState & { blocked: ReactElement | null } {
  const state = useCommunity(slug);
  const blocked = render(
    communityGate({
      loading: state.loading,
      hasCommunity: !!state.community,
      role: state.role,
      require: opts.require ?? "member",
    }),
  );
  return { ...state, blocked };
}

export function useSessionGate(): {
  sessionWallet: string | null;
  loading: boolean;
  blocked: ReactElement | null;
} {
  const { sessionWallet, loading } = useSession();
  return {
    sessionWallet,
    loading,
    blocked: render(sessionGate({ loading, sessionWallet })),
  };
}

/** The internal /dev tools page: signed in and on the DEV_WALLETS allowlist. */
export function useDevGate(): {
  sessionWallet: string | null;
  blocked: ReactElement | null;
} {
  const { sessionWallet, developer, loading } = useSession();
  return {
    sessionWallet,
    blocked: render(devGate({ loading, sessionWallet, developer })),
  };
}
