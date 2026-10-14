"use client";

import Link from "next/link";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "app-button-primary",
  secondary: "app-button-secondary",
  danger: "app-button-danger",
  ghost: "app-button-ghost",
};

/**
 * `loading` disables the button and prefixes a spinner; keep the label
 * describing what is happening ("Submitting…") so the state reads without it.
 */
export function Button({
  variant = "primary",
  className = "",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  loading?: boolean;
}) {
  return (
    <button
      className={`app-button ${VARIANT_CLASS[variant]} ${className}`}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <Spinner className="mr-2 h-4 w-4" />}
      {children}
    </button>
  );
}

/**
 * A link styled as a button. In-app links use next/link; `external` renders
 * a plain anchor (API routes that redirect, other sites — `newTab` opens
 * those in a new tab).
 */
export function LinkButton({
  href,
  variant = "primary",
  className = "",
  children,
  external = false,
  newTab = false,
}: {
  href: string;
  variant?: ButtonVariant;
  className?: string;
  children: ReactNode;
  external?: boolean;
  newTab?: boolean;
}) {
  const cls = `app-button ${VARIANT_CLASS[variant]} ${className}`;
  if (external) {
    return (
      <a
        href={href}
        className={cls}
        {...(newTab ? { target: "_blank", rel: "noreferrer" } : {})}
      >
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={cls}>
      {children}
    </Link>
  );
}
