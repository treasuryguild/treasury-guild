import { Spinner } from "@/components/ui";

/** Route-level pending UI while the server renders the signing page. */
export default function TxLoading() {
  return (
    <div className="mx-auto flex max-w-3xl items-center gap-2 text-sm text-zinc-400">
      <Spinner />
      Loading transaction…
    </div>
  );
}
