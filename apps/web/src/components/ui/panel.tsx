import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The Overview's list card: a quiet header strip with an uppercase title and
 * right-side links/actions, then a flush body (rows divide themselves).
 * Use for lists of rows ("Active now", "Recurring"); use `SectionCard` for
 * forms and settings blocks.
 */
export function Panel({
  title,
  actions,
  className,
  children,
}: {
  title: ReactNode;
  /** Right side of the header: "All →" links, "+ New" buttons, counts. */
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn("rounded-xl border border-border/70 bg-bg-card/35 overflow-hidden", className)}
    >
      <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 bg-bg-card/60 border-b border-border/60">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-text-muted">{title}</h2>
        {actions && <div className="flex flex-wrap items-center gap-3 text-xs">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/** The quiet one-line message a Panel shows when it has no rows. */
export function PanelEmpty({ className, children }: { className?: string; children: ReactNode }) {
  return <p className={cn("px-4 py-4 text-xs text-text-muted", className)}>{children}</p>;
}
