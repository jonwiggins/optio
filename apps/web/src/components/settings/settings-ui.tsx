import type { ReactNode } from "react";
import { Skeleton } from "@/components/skeleton";
import { SectionCard } from "@/components/ui/section-card";
import { cn } from "@/lib/utils";

/**
 * Shared bits for the Settings and Workspace settings pages, so every card
 * uses the New work form's field, label, and button styles.
 */

export const INPUT =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-50";
export const MONO_AREA =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 resize-y leading-relaxed";
export const LABEL = "block text-xs font-medium text-text-muted mb-1.5";
/** Small helper text under a field. */
export const HELP = "text-[11px] text-text-muted/80 mt-1";

/** The work-form footer's primary button. */
export const BTN_PRIMARY =
  "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50 whitespace-nowrap";
/** The matching secondary (outlined) button. */
export const BTN_SECONDARY =
  "inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-md border border-border bg-bg text-sm text-text hover:bg-bg-hover transition-colors disabled:opacity-50 whitespace-nowrap";
/** A compact header action (in a SectionCard's `actions`). */
export const BTN_HEADER =
  "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-border bg-bg-card text-xs text-text hover:bg-bg-hover transition-colors disabled:opacity-50 whitespace-nowrap";
/** The work-form footer's Cancel. */
export const BTN_TEXT = "text-sm text-text-muted hover:text-text transition-colors";
/** A quiet inline row action (Disable, Sync, …). */
export const BTN_ROW =
  "px-2 py-1 rounded-md text-xs text-text-muted hover:text-text hover:bg-bg-hover transition-colors disabled:opacity-50";
/** A row's delete / remove icon button. */
export const BTN_ROW_DANGER =
  "p-1.5 rounded-md text-text-muted hover:text-error hover:bg-error/10 transition-colors disabled:opacity-50";

/** The footer strip of a card: an optional note on the left, buttons on the right. */
export function CardFooter({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 pt-3 border-t border-border">
      <div className="text-xs text-text-muted/70 min-w-0">{note}</div>
      <div className="flex items-center gap-3 shrink-0">{children}</div>
    </div>
  );
}

/** A divider-separated group inside a card body. */
export function Field({
  label,
  help,
  children,
  className,
}: {
  label?: ReactNode;
  help?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      {label && <div className={LABEL}>{label}</div>}
      {children}
      {help && <p className={HELP}>{help}</p>}
    </div>
  );
}

/** A tinted inline form (add / replace) inside a card. */
export function InsetForm({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn("space-y-3 p-4 rounded-lg border border-primary/30 bg-primary/5", className)}
    >
      {children}
    </div>
  );
}

/** Shimmer lines in place of a card body while it loads. */
export function SkeletonBody({ rows = 3 }: { rows?: number }) {
  return (
    <div className="space-y-3" aria-busy="true">
      <Skeleton className="h-3 w-2/3" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-9 w-full" />
      ))}
    </div>
  );
}

/** A whole SectionCard in its loading state. */
export function SkeletonCard({
  label,
  hint,
  id,
  rows,
}: {
  label: ReactNode;
  hint?: ReactNode;
  id?: string;
  rows?: number;
}) {
  return (
    <SectionCard label={label} hint={hint} id={id}>
      <SkeletonBody rows={rows} />
    </SectionCard>
  );
}

/** The `{{VAR}}` reference list shown above a template editor. */
export function TemplateVars({ vars }: { vars: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 p-3 rounded-lg bg-bg border border-border text-xs">
      {vars.map(([name, desc]) => (
        <div key={name} className="contents">
          <dt>
            <code className="text-primary">{`{{${name}}}`}</code>
          </dt>
          <dd className="text-text-muted">{desc}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small rounded tag on a list row. */
export function Tag({
  tone = "muted",
  children,
  title,
}: {
  tone?: "muted" | "primary" | "warning" | "error" | "success";
  children: ReactNode;
  title?: string;
}) {
  const tones = {
    muted: "bg-bg-hover text-text-muted",
    primary: "bg-primary/10 text-primary",
    warning: "bg-warning/10 text-warning",
    error: "bg-error/10 text-error",
    success: "bg-success/10 text-success",
  } as const;
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}
