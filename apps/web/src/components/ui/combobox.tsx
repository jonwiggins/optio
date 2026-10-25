"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Check, ChevronDown, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { inputClass } from "./input";

export interface ComboboxOption {
  /** Unique in the list; what `onPick` reports. */
  id: string;
  /** The row's main text; with `freeText`, what the box shows once picked. */
  label: string;
  /** Smaller text after the label (an author, a PR's branches). */
  hint?: ReactNode;
  /** A small chip after the label ("default"). */
  badge?: ReactNode;
}

const SIZES = {
  md: { icon: "left-3 h-4 w-4", withIcon: "pl-9", right: "right-2", row: "text-sm" },
  sm: { icon: "left-2.5 h-3.5 w-3.5", withIcon: "pl-8", right: "right-1.5", row: "text-[13px]" },
} as const;

/**
 * A text box with a list of suggestions under it (branches, merge requests).
 * The parent owns the data: it gets `onSearch(query)` as the text changes
 * (debounced; once with "" when the list opens) and hands back `options`;
 * `onPick` reports a chosen row. ArrowDown / ArrowUp move along the rows,
 * Enter takes the highlighted one (or the first, or the exact match), the
 * mouse works too, Escape closes. With `freeText`, Enter or leaving the box
 * keeps what was typed (`onCommit`), so a name the list doesn't have still
 * goes through. `error` is a hint under the rows, never a block.
 */
export function Combobox({
  id,
  value,
  options,
  onPick,
  onCommit,
  onSearch,
  onClear,
  freeText = false,
  loading = false,
  error,
  label,
  placeholder,
  icon,
  emptyMessage,
  size = "md",
  mono = false,
  className,
  inputClassName,
  debounceMs = 250,
  disabled,
  testId,
}: {
  /** The input's `id`, for a `<label htmlFor>`. */
  id?: string;
  /** What the box shows while closed: the committed name, a picked row's label, or "". */
  value: string;
  options: ComboboxOption[];
  onPick: (option: ComboboxOption) => void;
  /** `freeText` only: the typed text, on Enter or when focus leaves. */
  onCommit?: (text: string) => void;
  /** The text to search for; "" when the list opens with nothing typed. */
  onSearch: (query: string) => void;
  /** When given, an × clears the value while the box is closed and not empty. */
  onClear?: () => void;
  /** Keep what's typed as the value, even when no row matches it. */
  freeText?: boolean;
  loading?: boolean;
  /** Why the list is empty or short (no credentials); shown under the rows. */
  error?: string | null;
  /** The accessible name. */
  label: string;
  /** Shown while open with nothing typed (defaults to the value) and when empty. */
  placeholder?: string;
  icon?: ReactNode;
  /** What to say when nothing matches; gets the query. */
  emptyMessage?: (query: string) => ReactNode;
  size?: keyof typeof SIZES;
  /** Monospace rows and value (branch names). */
  mono?: boolean;
  className?: string;
  inputClassName?: string;
  debounceMs?: number;
  disabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const listId = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // The latest search callback, so the debounce effect doesn't re-run when
  // the parent passes a new arrow function each render.
  const searchRef = useRef(onSearch);
  searchRef.current = onSearch;
  const s = SIZES[size];

  // Ask for rows while open: at once when the list opens, debounced as you type.
  useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => searchRef.current(query), query ? debounceMs : 0);
    return () => clearTimeout(t);
  }, [open, query, debounceMs]);

  // Keep the highlight inside the list as the rows change.
  useEffect(() => {
    setActive((a) => (a >= options.length ? options.length - 1 : a));
  }, [options.length]);

  useEffect(() => {
    if (active < 0) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setActive(-1);
  };

  const pick = (option: ComboboxOption) => {
    onPick(option);
    close();
  };

  const commitTyped = () => {
    const text = query.trim();
    if (freeText && text) onCommit?.(text);
    close();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setActive((a) => Math.min(a + 1, options.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, -1));
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      const highlighted = active >= 0 ? options[active] : undefined;
      const typed = query.trim().toLowerCase();
      const exact = typed ? options.find((o) => o.label.toLowerCase() === typed) : undefined;
      const chosen = highlighted ?? exact ?? (!freeText ? options[0] : undefined);
      if (chosen) pick(chosen);
      else commitTyped();
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        close();
      }
    }
  };

  const showList = open && (options.length > 0 || loading || !!error || !!query.trim());
  const optionId = (i: number) => `${listId}-option-${i}`;

  return (
    <div
      className={cn("relative", className)}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        if (open) commitTyped();
      }}
    >
      {icon && (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 text-text-muted [&>svg]:h-full [&>svg]:w-full",
            s.icon,
          )}
        >
          {icon}
        </span>
      )}
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-label={label}
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        value={open ? query : value}
        placeholder={open ? value || placeholder : placeholder}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(-1);
          if (!open) setOpen(true);
        }}
        onKeyDown={onKeyDown}
        data-testid={testId}
        className={inputClass({
          size,
          className: cn(icon && s.withIcon, "pr-8", mono && "font-mono", inputClassName),
        })}
      />
      <span className={cn("absolute top-1/2 -translate-y-1/2 flex items-center", s.right)}>
        {loading && open ? (
          <Loader2 aria-hidden className="h-3.5 w-3.5 animate-spin text-text-muted" />
        ) : onClear && value && !open ? (
          <button
            type="button"
            aria-label={`Clear ${label.toLowerCase()}`}
            title="Clear"
            onClick={onClear}
            className="rounded-md p-0.5 text-text-muted hover:bg-bg-hover hover:text-text"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : (
          <ChevronDown aria-hidden className="h-3.5 w-3.5 text-text-muted/70" />
        )}
      </span>
      {showList && (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-20 mt-1 w-full max-h-72 overflow-auto rounded-lg border border-border bg-bg-card shadow-lg py-1"
        >
          {options.map((o, i) => (
            <button
              key={o.id}
              type="button"
              role="option"
              id={optionId(i)}
              data-index={i}
              aria-selected={i === active}
              // Keep focus in the input so the list doesn't close before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
              className={cn(
                "w-full flex items-center gap-2 px-3 py-1.5 text-left transition-colors",
                s.row,
                i === active ? "bg-bg-hover text-text" : "text-text",
                o.label === value && "text-primary",
              )}
            >
              <span className={cn("truncate", mono && "font-mono")}>{o.label}</span>
              {o.badge && (
                <span className="shrink-0 inline-flex items-center text-[10px] leading-4 px-1.5 rounded-full border border-border bg-bg text-text-muted">
                  {o.badge}
                </span>
              )}
              {o.hint && (
                <span className="min-w-0 flex-1 truncate text-[11px] text-text-muted">
                  {o.hint}
                </span>
              )}
              {o.label === value && <Check className="ml-auto h-3.5 w-3.5 shrink-0" />}
            </button>
          ))}
          {options.length === 0 && !loading && (
            <div className="px-3 py-2 text-xs text-text-muted">
              {emptyMessage
                ? emptyMessage(query)
                : query.trim()
                  ? `No match for “${query.trim()}”`
                  : "Nothing to show"}
            </div>
          )}
          {options.length === 0 && loading && (
            <div className="px-3 py-2 text-xs text-text-muted">Loading…</div>
          )}
          {error && (
            <div className="px-3 py-1.5 text-[11px] text-text-muted/80 border-t border-border/60">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
