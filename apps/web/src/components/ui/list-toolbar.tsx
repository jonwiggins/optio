"use client";

import type { ReactNode } from "react";
import { SearchField } from "./search-field";

/** Search and filters share the same spacing across the product's lists. */
export function ListToolbar({
  search,
  children,
  count,
}: {
  search?: { value: string; onChange: (value: string) => void; label: string };
  children?: ReactNode;
  count?: ReactNode;
}) {
  return (
    <div className="mb-5 flex min-w-0 flex-wrap items-center gap-3">
      {search && (
        <SearchField
          value={search.value}
          onChange={search.onChange}
          label={search.label}
          className="w-full sm:max-w-sm"
          inputClassName="bg-bg-card/60"
        />
      )}
      {children}
      {count !== undefined && (
        <span aria-live="polite" className="ml-auto text-xs tabular-nums text-text-muted">
          {count}
        </span>
      )}
    </div>
  );
}
