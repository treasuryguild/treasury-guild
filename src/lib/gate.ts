// Pure access-gate decisions for community/session pages. The hook in
// hooks/useCommunityGate.tsx renders these; keeping the decision pure makes
// it unit-testable.

import { isAdminRole } from "./roles";

/** What a page needs before it renders. */
export type GateRequirement = "community" | "member" | "admin";

export type GateDecision =
  | { kind: "loading" }
  | { kind: "blocked"; message: string }
  | { kind: "ok" };

export const GATE_MESSAGES = {
  notFound: "Community not found.",
  membersOnly: "Members only.",
  adminOnly: "Admin access required.",
  signIn: "Sign in with your wallet first.",
  devOnly: "Developer access required.",
} as const;

export function communityGate(input: {
  loading: boolean;
  hasCommunity: boolean;
  role: string | null;
  require: GateRequirement;
}): GateDecision {
  if (input.loading) return { kind: "loading" };
  if (!input.hasCommunity) {
    return { kind: "blocked", message: GATE_MESSAGES.notFound };
  }
  if (input.require === "community") return { kind: "ok" };
  if (!input.role) {
    return { kind: "blocked", message: GATE_MESSAGES.membersOnly };
  }
  if (input.require === "admin" && !isAdminRole(input.role)) {
    return { kind: "blocked", message: GATE_MESSAGES.adminOnly };
  }
  return { kind: "ok" };
}

export function sessionGate(input: {
  loading: boolean;
  sessionWallet: string | null;
}): GateDecision {
  if (input.loading) return { kind: "loading" };
  if (!input.sessionWallet) {
    return { kind: "blocked", message: GATE_MESSAGES.signIn };
  }
  return { kind: "ok" };
}

/** Internal tools: signed in, and the wallet is on the DEV_WALLETS allowlist. */
export function devGate(input: {
  loading: boolean;
  sessionWallet: string | null;
  developer: boolean;
}): GateDecision {
  const session = sessionGate(input);
  if (session.kind !== "ok") return session;
  if (!input.developer) {
    return { kind: "blocked", message: GATE_MESSAGES.devOnly };
  }
  return { kind: "ok" };
}
