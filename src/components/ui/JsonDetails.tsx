import Link from "next/link";

/** Explains the keys of the JSON shown: rendered above it as a legend. */
export interface JsonLegend {
  title: string;
  entries: readonly { key: string; meaning: string }[];
  /** Long-form reference to link to. */
  docs?: { href: string; label: string };
}

/** Collapsible pretty-printed JSON (on-chain metadata previews, raw payloads). */
export function JsonDetails({
  label,
  value,
  open = false,
  legend,
}: {
  label: string;
  value: unknown;
  open?: boolean;
  legend?: JsonLegend | null;
}) {
  if (value === null || value === undefined) return null;
  return (
    <details className="mt-3" open={open}>
      <summary className="cursor-pointer text-xs text-zinc-400">{label}</summary>
      {legend && (
        <div className="mt-2 rounded-lg border border-zinc-800 p-3 text-xs">
          <p className="mb-2 text-zinc-400">
            {legend.title} · what the keys mean
            {legend.docs && (
              <>
                {" · "}
                <Link href={legend.docs.href} className="text-indigo-400 hover:underline">
                  {legend.docs.label}
                </Link>
              </>
            )}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            {legend.entries.map((e) => (
              <div key={e.key} className="contents">
                <dt className="font-mono text-zinc-200">{e.key}</dt>
                <dd className="text-zinc-400">{e.meaning}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      <pre className="mt-2 whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 text-xs text-zinc-300">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}
