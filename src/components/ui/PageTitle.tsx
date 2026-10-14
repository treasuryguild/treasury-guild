import type { ReactNode } from "react";

export function PageTitle({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex min-w-0 flex-col items-start justify-between gap-4 lg:flex-row lg:items-center">
      <h1 className="min-w-0 text-2xl font-semibold tracking-tight sm:text-3xl">
        {children}
      </h1>
      {action && <div className="page-actions min-w-0 w-full lg:w-auto">{action}</div>}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
  className = "",
}: {
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3 ${className}`}>
      <h2 className="min-w-0 text-lg font-medium">{children}</h2>
      {action}
    </div>
  );
}
