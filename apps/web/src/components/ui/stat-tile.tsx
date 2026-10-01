import Link from "next/link";
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One headline number: an uppercase 11px label with an icon, then a
 * text-2xl tabular value. `tone` (e.g. "text-warning") colours both the icon
 * and the value — pass it only when the number deserves attention. With
 * `href` the whole tile is a link.
 */
export function StatTile({
  label,
  value,
  icon: Icon,
  tone,
  href,
  className,
}: {
  label: ReactNode;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  tone?: string;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-text-muted/70">
        {Icon && <Icon className={cn("w-3 h-3", tone)} />}
        {label}
      </div>
      <div className={cn("text-2xl font-semibold tabular-nums mt-1", tone ?? "text-text-heading")}>
        {value}
      </div>
    </>
  );
  const cls = cn(
    "rounded-xl border border-border/70 bg-bg-card/50 px-4 py-3",
    href && "hover:border-primary/40 transition-colors",
    className,
  );
  return href ? (
    <Link href={href} className={cls}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}
