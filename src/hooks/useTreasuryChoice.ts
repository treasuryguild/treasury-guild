"use client";

import { useEffect, useState } from "react";

/** The treasury a page builds from; a community with a single treasury needs no choice. */
export function useTreasuryChoice<T extends { id: string }>(treasuries: readonly T[] | null | undefined) {
  const [treasuryId, setTreasuryId] = useState("");
  useEffect(() => {
    if (treasuries?.length === 1) setTreasuryId(treasuries[0]!.id);
  }, [treasuries]);
  const selectedTreasury = treasuries?.find((t) => t.id === treasuryId) ?? null;
  return { treasuryId, setTreasuryId, selectedTreasury };
}
