import { Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { ownerScope, type Owned } from "@/lib/owner";

/**
 * The one chip for a private row: **Private** for the viewer's own, **Private
 * · Name** for someone else's (what an admin sees). Organization rows carry
 * no chip — they're the norm. Shown where rows of different scopes mix
 * without sections: search results, the Work list, pickers, detail headers.
 */
export function OwnerChip({
  row,
  viewerId,
  size = "xs",
  className,
}: {
  row: Owned;
  viewerId: string | null;
  size?: "xs" | "sm";
  className?: string;
}) {
  const scope = ownerScope(row, viewerId);
  if (scope === "organization") return null;
  const other = scope === "others";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded font-medium whitespace-nowrap",
        size === "sm" ? "text-xs px-2 py-0.5 rounded-md" : "text-[10px] px-1.5 py-0.5",
        other ? "bg-bg-hover text-text-muted" : "bg-primary/10 text-primary",
        className,
      )}
      title={
        other
          ? `${row.ownerName ?? "Someone"}'s private — runs with their credentials; only they can change or use it`
          : "Private — only you see it and only your work can use it"
      }
    >
      <Lock className={size === "sm" ? "w-3 h-3" : "w-2.5 h-2.5"} />
      {other ? `Private · ${row.ownerName ?? "someone"}` : "Private"}
    </span>
  );
}
