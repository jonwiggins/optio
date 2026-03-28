import Link from "next/link";
import { Plus } from "lucide-react";

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: any;
  title: string;
  description: string;
  action?: { label: string; href: string };
}) {
  return (
    <div className="flex flex-col items-center justify-center py-14 px-6 rounded-xl border border-dashed border-border bg-bg-card/50">
      <div className="p-3.5 rounded-2xl bg-bg-hover/70 mb-4">
        <Icon className="w-7 h-7 text-text-muted/60" />
      </div>
      <span className="text-sm font-medium text-text-heading">{title}</span>
      <p className="text-xs text-text-muted mt-1.5 text-center max-w-xs leading-relaxed">
        {description}
      </p>
      {action && (
        <Link
          href={action.href}
          className="mt-5 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg bg-primary text-white hover:bg-primary-hover transition-all btn-press shadow-sm shadow-primary/20 hover:shadow-md hover:shadow-primary/25"
        >
          <Plus className="w-3.5 h-3.5" />
          {action.label}
        </Link>
      )}
    </div>
  );
}
