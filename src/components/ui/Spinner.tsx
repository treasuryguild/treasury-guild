import { Loader2 } from "lucide-react";

/** Inline spinning indicator. Decorative — pair it with visible text. */
export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={`shrink-0 animate-spin ${className}`} />;
}
