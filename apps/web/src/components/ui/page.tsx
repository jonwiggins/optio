import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The one page column. Every page — lists, detail pages, settings, forms —
 * lays out in it, so the title, the content and the actions sit at the same
 * left and right edges whichever page you're on. `DetailHeader` uses it too,
 * inside its full-bleed band. The `page-column` utility is defined in
 * app/globals.css (max-w-6xl, centred, px-6); use it directly in class strings.
 */
export const PAGE_COLUMN = "page-column";

/**
 * The measure for a form body: a readable line length, left-aligned under the
 * page header (never re-centred, which would move the left edge).
 */
export const FORM_WIDTH = "max-w-3xl";

/** A page's content area: the page column with the standard vertical padding. */
export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn(PAGE_COLUMN, "py-6", className)}>{children}</div>;
}
