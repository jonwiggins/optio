"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Check, Search, X } from "lucide-react";
import { Segmented } from "@/components/ui/segmented";
import { inputClass } from "@/components/ui/input";

/** A tiny pill for labels and flags inside a row's title / meta line. */
export function Chip({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center text-[10px] leading-4 px-1.5 rounded-full border border-border bg-bg text-text-muted shrink-0",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** Loading placeholder shaped like the rows: glyph, title + meta, recency. */
export function RowSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div
      className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60"
      aria-busy="true"
      aria-label="Loading"
    >
      {[...Array(rows)].map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-4 bg-bg-card/40"
        >
          <div className="w-4 h-4 rounded-full skeleton-shimmer" />
          <div className="space-y-1.5">
            <div className="h-3.5 skeleton-shimmer" style={{ width: `${60 - (i % 3) * 12}%` }} />
            <div className="h-2.5 w-1/3 skeleton-shimmer" />
          </div>
          <div className="h-2.5 w-12 skeleton-shimmer" />
        </div>
      ))}
    </div>
  );
}

type RepoOption = { id: string; fullName: string };

/**
 * Narrow a list to one repo. A few repos get pills; more get a search box
 * that suggests matching repos (the same box as the Work list's search).
 */
export function RepoFilter({
  repos,
  value,
  onChange,
}: {
  repos: RepoOption[];
  value: string;
  onChange: (repoId: string) => void;
}) {
  if (repos.length < 2) return null;
  if (repos.length <= 4) {
    return (
      <Segmented
        size="md"
        surface="card"
        wrap
        className="gap-1"
        aria-label="Repository"
        value={value}
        onChange={onChange}
        options={[
          { value: "", label: "All repos" },
          ...repos.map((r) => ({ value: r.id, label: r.fullName })),
        ]}
      />
    );
  }
  return <RepoSearch repos={repos} value={value} onChange={onChange} />;
}

function RepoSearch({
  repos,
  value,
  onChange,
}: {
  repos: RepoOption[];
  value: string;
  onChange: (repoId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const selected = repos.find((r) => r.id === value);
  const needle = q.trim().toLowerCase();
  const matches = repos.filter((r) => r.fullName.toLowerCase().includes(needle));
  const pick = (id: string) => {
    onChange(id);
    setQ("");
    setOpen(false);
  };
  return (
    <div
      className="relative w-full sm:w-72"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setQ("");
        }
      }}
    >
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
      <input
        value={open ? q : (selected?.fullName ?? "")}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setQ(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") (e.target as HTMLInputElement).blur();
          if (e.key === "Enter" && needle && matches[0]) pick(matches[0].id);
        }}
        placeholder={selected ? selected.fullName : `All repos (${repos.length}) — search…`}
        aria-label="Filter by repository"
        role="combobox"
        aria-expanded={open}
        className={inputClass({
          size: "sm",
          className: cn("pl-8 bg-bg-card", selected ? "pr-8 font-mono" : "pr-3"),
        })}
      />
      {selected && !open && (
        <button
          type="button"
          onClick={() => pick("")}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded-md text-text-muted hover:text-text hover:bg-bg-hover"
          aria-label="Show all repos"
          title="Show all repos"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
      {open && (
        <div
          role="listbox"
          className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-border bg-bg-card shadow-lg py-1"
        >
          {!needle && <RepoOptionRow label="All repos" active={!value} onPick={() => pick("")} />}
          {matches.map((r) => (
            <RepoOptionRow
              key={r.id}
              label={r.fullName}
              mono
              active={r.id === value}
              onPick={() => pick(r.id)}
            />
          ))}
          {matches.length === 0 && (
            <div className="px-3 py-2 text-xs text-text-muted">No repo matches “{q}”</div>
          )}
        </div>
      )}
    </div>
  );
}

function RepoOptionRow({
  label,
  active,
  mono,
  onPick,
}: {
  label: string;
  active: boolean;
  mono?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      // Keep focus in the input so the list doesn't close before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-bg-hover transition-colors",
        active ? "text-primary" : "text-text",
        mono && "font-mono text-[13px]",
      )}
    >
      <span className="truncate flex-1">{label}</span>
      {active && <Check className="w-3.5 h-3.5 shrink-0" />}
    </button>
  );
}
