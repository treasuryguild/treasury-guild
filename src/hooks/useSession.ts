"use client";

import { useContext } from "react";
import {
  SessionContext,
  type SessionContextValue,
} from "@/components/providers/SessionProvider";

/** Shared session state — one instance for the whole tree (SessionProvider). */
export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used inside <SessionProvider>");
  }
  return ctx;
}
