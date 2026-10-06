import Link from "next/link";
import type { ButtonHTMLAttributes, ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const BASE =
  "inline-flex items-center justify-center rounded-lg font-medium transition-colors whitespace-nowrap disabled:opacity-50 disabled:pointer-events-none";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white shadow-sm shadow-primary/10 hover:bg-primary-hover",
  secondary: "border border-border bg-bg-card text-text-muted hover:text-text hover:bg-bg-hover",
  ghost: "text-text-muted hover:text-text hover:bg-bg-hover",
  danger: "bg-error/10 text-error hover:bg-error/20",
};

const SIZES: Record<ButtonSize, string> = {
  // Page-level actions: PageHeader / DetailHeader, form submits.
  md: "gap-2 px-4 py-2 text-sm [&_svg]:w-4 [&_svg]:h-4",
  // Actions inside a card, row, or panel.
  sm: "gap-1.5 px-3 py-1.5 text-xs [&_svg]:w-3.5 [&_svg]:h-3.5",
};

/** The classes of a standard button, for elements that can't be a `Button` / `ButtonLink`. */
export function buttonClass({
  variant = "primary",
  size = "md",
  className,
}: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {}): string {
  return cn(BASE, VARIANTS[variant], SIZES[size], className);
}

type Style = { variant?: ButtonVariant; size?: ButtonSize };

/** A standard button. `type` defaults to "button" (never an accidental submit). */
export function Button({
  variant,
  size,
  className,
  type = "button",
  ...props
}: Style & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button type={type} className={buttonClass({ variant, size, className })} {...props} />;
}

/** A link that looks like a standard button. */
export function ButtonLink({
  variant,
  size,
  className,
  ...props
}: Style & ComponentProps<typeof Link>) {
  return <Link className={buttonClass({ variant, size, className })} {...props} />;
}
