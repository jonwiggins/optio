import { cn } from "@/lib/utils";

export function MetadataCard({
  icon: Icon,
  label,
  value,
  size = "sm",
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: React.ReactNode;
  size?: "sm" | "lg";
}) {
  const valueClass =
    size === "lg"
      ? "text-2xl font-semibold tracking-tight tabular-nums"
      : "text-sm font-semibold truncate";
  const title = typeof value === "string" ? value : undefined;
  return (
    <div className="min-w-0 rounded-xl border border-border/70 bg-bg-card/50 px-4 py-4">
      <div className="flex items-center gap-2 text-[11px] font-medium text-text-muted mb-2">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      <div className={cn(valueClass)} title={title}>
        {value}
      </div>
    </div>
  );
}
