"use client";

// Sign / reject / submit / delete for one pending transaction. Every action
// refreshes the server-rendered page on success; a 409 conflict (another
// signature landed) refreshes too so the signer re-signs the latest CBOR.
// The refresh runs inside a transition so `busy` holds until the refreshed
// page has rendered — otherwise the buttons re-enable on stale data.
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { IWallet } from "@meshsdk/core";
import { ApiError, apiFetch, describeApiError } from "@/lib/api/client";
import type { SignTxResponse } from "@/lib/api/types";
import { MSG } from "@/lib/constants";
import { routes } from "@/lib/routes";

export type TxAction = "sign" | "reject" | "submit" | "delete" | "cancel";

export function useTxActions(txId: string, slug: string) {
  const router = useRouter();
  const [busy, setBusy] = useState<TxAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  async function perform(
    action: TxAction,
    task: () => Promise<unknown>,
    onDone: () => void = () => router.refresh(),
  ): Promise<void> {
    setBusy(action);
    setError(null);
    try {
      await task();
      startTransition(onDone);
    } catch (err) {
      if (err instanceof ApiError && err.conflict) startTransition(() => router.refresh());
      setError(describeApiError(err, `${action} failed`));
    } finally {
      setBusy(null);
    }
  }

  const post = <T,>(action: "sign" | "reject" | "submit" | "cancel", body?: unknown) =>
    apiFetch<T>(`/api/tx/${txId}/${action}`, { method: "POST", body });

  const leaveTreasury = () => {
    router.replace(routes.treasury(slug));
    router.refresh();
  };

  return {
    busy,
    /** True while the post-action page refresh is still rendering. */
    refreshing: isPending,
    error,
    /**
     * Sign, then submit in the same go when `shouldSubmit(signedAddresses)`
     * says this signature completed the path's rule (who signed matters: a
     * co-signed transaction needs the co-signer, not a count). A submit
     * failure after the signature landed is reported but the signature stays
     * recorded — the refreshed page offers a manual "Submit to chain" retry.
     */
    sign: (
      wallet: IWallet | null,
      txCbor: string,
      shouldSubmit: (signedAddresses: string[]) => boolean = () => false,
    ) => {
      if (!wallet) {
        setError(MSG.connectWallet);
        return Promise.resolve();
      }
      return perform("sign", async () => {
        // Partial sign: the wallet returns witness-set-only CBOR.
        const signedPayloadHex = await wallet.signTx(txCbor, true);
        const { signedAddresses } = await post<SignTxResponse>("sign", { signedPayloadHex });
        if (!shouldSubmit(signedAddresses)) return;
        setBusy("submit");
        try {
          await post("submit");
        } catch (err) {
          setError(describeApiError(err, "submit failed"));
        }
      });
    },
    reject: () => perform("reject", () => post("reject")),
    submit: () => perform("submit", () => post("submit")),
    remove: () =>
      perform("delete", () => apiFetch(`/api/tx/${txId}`, { method: "DELETE" }), leaveTreasury),
    cancel: () => perform("cancel", () => post("cancel"), leaveTreasury),
  };
}
