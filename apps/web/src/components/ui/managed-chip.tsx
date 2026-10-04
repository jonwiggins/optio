import { FileCode2 } from "lucide-react";
import type { ManagedBy } from "@optio/shared";
import { cn } from "@/lib/utils";

/** What a managed row's chip and banner say about the file. */
export function managedTitle(managedBy: ManagedBy): string {
  return `Managed by ${managedBy.sourceName} · ${managedBy.path} — edits made here are put back at the next sync; change the file instead`;
}

/**
 * The one chip for a row a configuration directory manages (config as code):
 * **Managed**, with the file on hover. Rows nobody manages carry no chip.
 * Shown next to the Private chip wherever rows are listed.
 */
export function ManagedChip({
  managedBy,
  size = "xs",
  className,
}: {
  managedBy?: ManagedBy | null;
  size?: "xs" | "sm";
  className?: string;
}) {
  if (!managedBy) return null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded font-medium whitespace-nowrap bg-bg-hover text-text-muted",
        size === "sm" ? "text-xs px-2 py-0.5 rounded-md" : "text-[10px] px-1.5 py-0.5",
        className,
      )}
      title={managedTitle(managedBy)}
    >
      <FileCode2 className={size === "sm" ? "w-3 h-3" : "w-2.5 h-2.5"} />
      Managed
    </span>
  );
}
