"use client";

import type { ReactNode } from "react";
import { Search, X } from "lucide-react";
import { inputClass } from "./input";

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
        <div className="relative w-full sm:max-w-sm">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-muted"
          />
          <input
            type="search"
            aria-label={search.label}
            placeholder={search.label}
            value={search.value}
            onChange={(event) => search.onChange(event.target.value)}
            className={inputClass({
              className:
                "pl-9 pr-9 bg-bg-card/60 [&::-webkit-search-cancel-button]:appearance-none",
            })}
          />
          {search.value && (
            <button
              type="button"
              aria-label={`Clear ${search.label.toLowerCase()}`}
              onClick={() => search.onChange("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-text-muted hover:bg-bg-hover hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
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
