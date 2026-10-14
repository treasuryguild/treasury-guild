"use client";

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

/** Label + control + optional hint. */
export function Field({
  label,
  hint,
  size = "md",
  className = "",
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  size?: "sm" | "md";
  className?: string;
  children: ReactNode;
}) {
  const labelClass =
    size === "sm"
      ? "mb-1 block text-xs text-zinc-400"
      : "mb-1 block text-sm text-zinc-400";
  return (
    <div className={className}>
      <label className={labelClass}>{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

export function Input({
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`form-control ${className}`} {...props} />;
}

export function Textarea({
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`form-control ${className}`} {...props} />;
}

export function Select({
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`form-control ${className}`} {...props} />;
}
