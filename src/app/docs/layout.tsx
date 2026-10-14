import type { ReactNode } from "react";
import { DocsNav } from "@/components/docs/DocsNav";

// Public documentation: no wallet or session needed. The AppShell around it
// still shows the sidebar and wallet bar like every other page.
export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[14rem_minmax(0,1fr)] lg:gap-10">
      <aside className="min-w-0 lg:sticky lg:top-24 lg:self-start">
        <DocsNav />
      </aside>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
