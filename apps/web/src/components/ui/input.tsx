import { cn } from "@/lib/utils";

const BASE =
  "w-full rounded-lg border border-border bg-bg text-text placeholder:text-text-muted/60 focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 disabled:opacity-50";

const SIZES = {
  // Forms and settings.
  md: "px-3 py-2 text-sm",
  // Dense rows: filters, inline edits, table cells.
  sm: "px-2.5 py-1.5 text-xs",
} as const;

/**
 * The classes of a standard text field (`<input>`, `<textarea>`, `<select>`).
 * Pass `className` for layout (`flex-1`, `font-mono`, `h-40`); twMerge lets it
 * override the base where it must.
 */
export function inputClass({
  size = "md",
  className,
}: { size?: keyof typeof SIZES; className?: string } = {}): string {
  return cn(BASE, SIZES[size], className);
}
