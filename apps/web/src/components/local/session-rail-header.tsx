"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { IfCanMutate } from "@/components/role-gate";
import { SearchField } from "@/components/ui/search-field";

/** Search is local to the sessions listed below, in both execution locations. */
export function SessionRailHeader({
  count,
  search,
  onSearch,
  onNavigate,
  children,
}: {
  count: number;
  search: string;
  onSearch: (value: string) => void;
  onNavigate?: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="shrink-0 border-b border-border/60 px-3 pb-3">
      <Link
        href="/work"
        onClick={onNavigate}
        className="mb-3 flex items-center gap-1.5 py-1 text-xs text-text-muted transition-colors hover:text-text"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        All work
      </Link>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold tracking-tight text-text-heading">Sessions</h2>
          <span
            title="Live sessions"
            aria-label={`${count} live`}
            className="rounded-md bg-bg-hover px-1.5 py-0.5 text-[11px] tabular-nums text-text-muted"
          >
            {count}
          </span>
        </div>
        <IfCanMutate>
          <Link
            href="/work/new"
            onClick={onNavigate}
            title="New session"
            aria-label="New session"
            className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-primary/15 bg-primary/10 text-primary transition-colors hover:bg-primary/20"
          >
            <Plus className="h-4 w-4" />
          </Link>
        </IfCanMutate>
      </div>
      <SearchField
        value={search}
        onChange={onSearch}
        label="Search sessions"
        placeholder="Search sessions…"
        size="sm"
      />
      {children}
    </div>
  );
}
