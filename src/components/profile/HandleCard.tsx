"use client";

// Self-service display handle (contributors.handle) — the non-GitHub way to
// show up by name in assignee dropdowns and member lists. The 0011 column
// grant allows exactly this self-update. Shared by /welcome and /settings.

import { useEffect, useState } from "react";
import { PgCode } from "@/lib/constants";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useContributorProfile } from "@/hooks/useContributorProfile";
import { Button, Card, ErrorText, Input } from "@/components/ui";

export function HandleCard() {
  const { data: profile, sessionWallet, setData } = useContributorProfile();
  const [handle, setHandle] = useState("");
  const save = useAsyncAction("Could not save the handle.");
  const savedHandle = profile?.handle ?? null;

  useEffect(() => {
    setHandle(savedHandle ?? "");
  }, [savedHandle]);

  async function saveHandle() {
    const trimmed = handle.trim();
    if (!trimmed || !sessionWallet) return;
    await save.run(async () => {
      const { error } = await browserClient()
        .from("contributors")
        .update({ handle: trimmed })
        .eq("wallet_address", sessionWallet);
      if (error) {
        throw new Error(
          error.code === PgCode.UniqueViolation
            ? "That handle is already taken."
            : "Could not save the handle.",
        );
      }
      setData((prev) => ({ github_username: null, ...prev, handle: trimmed }));
    });
  }

  const unchanged = handle.trim() === savedHandle;

  return (
    <Card>
      <h3 className="font-medium">Display handle</h3>
      <p className="mt-1 text-sm text-zinc-400">
        Optional name shown to other members instead of your address — no
        GitHub account needed. Used in member lists and assignee dropdowns.
      </p>
      <div className="mt-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
        <Input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="e.g. ada-lovelace"
          className="sm:max-w-xs"
        />
        <Button
          variant="secondary"
          disabled={save.busy || !handle.trim() || unchanged}
          onClick={() => void saveHandle()}
        >
          {savedHandle && unchanged ? "Saved" : "Save"}
        </Button>
      </div>
      <ErrorText error={save.error} className="mt-2" />
    </Card>
  );
}
