"use client";

// Compact status row on a feature page: always links to the Integrations hub
// section that configures the connection (never hosts the editor itself).
import Link from "next/link";
import type { ReactNode } from "react";

export function IntegrationStatusLink({
  label,
  status,
  href,
}: {
  label: string;
  status: ReactNode;
  href: string;
}) {
  return (
    <p className="text-sm text-zinc-400">
      <span className="text-zinc-300">{label}</span>
      {" · "}
      {status}
      {" · "}
      <Link className="text-indigo-400 hover:underline" href={href}>
        Configure on Integrations
      </Link>
    </p>
  );
}
