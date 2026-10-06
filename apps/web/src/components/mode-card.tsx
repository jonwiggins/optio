"use client";

import { cn } from "@/lib/utils";

/** A big either/or card: the first choice on the New Task / New work forms. */
export function ModeCard({
  active,
  onClick,
  icon,
  title,
  subtitle,
  description,
  disabled,
  disabledHint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  description: string;
  disabled?: boolean;
  disabledHint?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "p-4 rounded-xl border text-left transition-colors",
        active
          ? "border-primary/60 bg-primary/10"
          : disabled
            ? "border-border bg-bg-card/40 opacity-60 cursor-not-allowed"
            : "border-border bg-bg-card hover:border-primary/40 cursor-pointer",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={cn(active ? "text-text" : "text-text-muted")}>{icon}</span>
        <h3 className="font-semibold text-sm">{title}</h3>
      </div>
      <p className={cn("text-xs font-medium mb-1.5", active ? "text-text-heading" : "text-text")}>
        {subtitle}
      </p>
      <p className="text-xs text-text-muted leading-relaxed">{description}</p>
      {disabled && disabledHint && <p className="text-xs text-text-muted mt-2">{disabledHint}</p>}
    </button>
  );
}
