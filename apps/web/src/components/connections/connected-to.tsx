"use client";

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, Plus, RotateCcw, Search, X } from "lucide-react";
import type { WorkEnvironmentEntry } from "@optio/shared";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import { ConnectionMark } from "@/components/connection-mark";
import { entryOwnerScope, entryPickReason, entrySubtext } from "@/lib/connections";

/**
 * "Connected to": the logo chips a piece of work is connected to and the
 * dropdown that adds more. One row per thing — a provider connection, a bare
 * secret, a hand-written MCP server — each a logo, a name, and a subtext
 * saying whose it is and what it is made of ("Private · tools + credentials
 * · Linear"). Grouped by whose: on by default, the viewer's own, the
 * organization's, other people's (never pickable).
 *
 * The caller owns the state: `isOn` says whether an entry is connected,
 * `onToggle` flips it. A default-on entry that was switched off stays
 * visible as a struck-through chip with an undo, so the user sees what they
 * turned off rather than it vanishing.
 */
export interface ConnectedToProps {
  /** Everything the work could be connected to (`catalog`); null while loading. */
  entries: WorkEnvironmentEntry[] | null;
  isOn: (entry: WorkEnvironmentEntry) => boolean;
  onToggle: (entry: WorkEnvironmentEntry, on: boolean) => void;
  viewerId: string | null;
  /** Whose the work is: private rows are pickable only for the viewer's own work. */
  workOwner: "workspace" | "me";
  /** Whether the defaults are a repo's (changes the group's name). */
  hasRepo: boolean;
  /** Only these entries are offered (a command Job: secrets and shell env). */
  filter?: (entry: WorkEnvironmentEntry) => boolean;
  /** The whole row is off, with the reason shown instead (work on a machine). */
  disabledReason?: string | null;
  /** Opens the gallery; the last row of the list. */
  onConnectNew?: () => void;
  label?: string;
  /** Hide the "default" tags and the defaults group (the repo page edits the defaults themselves). */
  plain?: boolean;
  /** Why a row can't be picked here (null = it can); replaces the work-form rule. */
  pickReason?: (entry: WorkEnvironmentEntry) => string | null;
  className?: string;
}

type Group = { key: string; title: string; rows: WorkEnvironmentEntry[] };

export function ConnectedTo({
  entries,
  isOn,
  onToggle,
  viewerId,
  workOwner,
  hasRepo,
  filter,
  disabledReason,
  onConnectNew,
  label = "Connected to",
  plain = false,
  pickReason: pickReasonProp,
  className,
}: ConnectedToProps) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const offered = useMemo(
    () => (entries ?? []).filter((e) => (filter ? filter(e) : true)),
    [entries, filter],
  );
  const on = offered.filter((e) => isOn(e));
  const struck = plain ? [] : offered.filter((e) => e.default && !isOn(e));
  const needle = q.trim().toLowerCase();
  const matches = needle
    ? offered.filter(
        (e) =>
          e.name.toLowerCase().includes(needle) ||
          (e.providerName ?? "").toLowerCase().includes(needle) ||
          entrySubtext(e, viewerId).toLowerCase().includes(needle),
      )
    : offered;

  const groups: Group[] = useMemo(() => {
    const defaults = plain ? [] : matches.filter((e) => e.default);
    const rest = plain ? matches : matches.filter((e) => !e.default);
    const by = (scope: ReturnType<typeof entryOwnerScope>) =>
      rest.filter((e) => entryOwnerScope(e, viewerId) === scope);
    return [
      {
        key: "defaults",
        title: hasRepo ? "From the repo's defaults" : "On by default",
        rows: defaults,
      },
      { key: "private", title: "Private", rows: by("private") },
      { key: "organization", title: "Organization", rows: by("organization") },
      { key: "others", title: "Other people's", rows: by("others") },
    ].filter((g) => g.rows.length > 0);
  }, [matches, viewerId, hasRepo, plain]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const close = () => {
    setOpen(false);
    setQ("");
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (e.key === "Enter" && needle) {
      const first = groups.flatMap((g) => g.rows).find((r) => !pickReason(r));
      if (first) {
        e.preventDefault();
        onToggle(first, !isOn(first));
      }
    }
  };

  const pickReason = (e: WorkEnvironmentEntry) =>
    pickReasonProp ? pickReasonProp(e) : entryPickReason(e, viewerId, workOwner);
  const defaultCount = plain ? 0 : on.filter((e) => e.default).length;

  return (
    <div className={cn("space-y-1.5", className)} data-testid="connected-to">
      <div className="flex items-center gap-1.5 text-xs text-text-muted">{label}</div>
      {disabledReason ? (
        <p className="text-[11px] text-text-muted/80 rounded-lg border border-dashed border-border px-3 py-2">
          {disabledReason}
        </p>
      ) : (
        <div
          className="relative"
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) close();
          }}
        >
          <div
            className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-bg p-1.5 min-h-[42px]"
            role="group"
            aria-label={label}
          >
            {on.map((e) => (
              <Chip
                key={`${e.kind}:${e.id}`}
                entry={e}
                viewerId={viewerId}
                tag={!plain && e.default ? "default" : null}
                onRemove={() => onToggle(e, false)}
                removeTitle={!plain && e.default ? "Turn off for this work" : "Disconnect"}
              />
            ))}
            {struck.map((e) => (
              <Chip
                key={`off:${e.kind}:${e.id}`}
                entry={e}
                viewerId={viewerId}
                struck
                onRestore={() => onToggle(e, true)}
              />
            ))}
            <button
              type="button"
              onClick={() => (open ? close() : setOpen(true))}
              className={cn(
                "inline-flex items-center gap-1 h-7 px-2 rounded-md text-xs border border-dashed border-border text-text-muted hover:text-text hover:border-border-strong hover:bg-bg-hover transition-colors",
                open && "border-primary/50 text-text",
              )}
              aria-haspopup="listbox"
              aria-expanded={open}
              aria-label="Add a connection"
            >
              <Plus className="w-3 h-3" /> Add
            </button>
          </div>
          {open && (
            <div className="absolute z-30 mt-1 w-full sm:w-[28rem] rounded-lg border border-border bg-bg-card shadow-lg">
              <div className="relative border-b border-border/60">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
                <input
                  ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={onKey}
                  placeholder="Search connections…"
                  role="combobox"
                  aria-expanded
                  aria-controls="connected-to-list"
                  aria-label="Search connections"
                  className={inputClass({
                    size: "sm",
                    className: "pl-8 border-0 rounded-b-none bg-transparent focus:ring-0",
                  })}
                />
              </div>
              <div
                id="connected-to-list"
                role="listbox"
                aria-multiselectable
                className="max-h-80 overflow-auto py-1"
              >
                {entries === null && (
                  <div className="px-3 py-2 text-xs text-text-muted">Loading…</div>
                )}
                {entries !== null && groups.length === 0 && (
                  <div className="px-3 py-2 text-xs text-text-muted">
                    {needle ? `Nothing matches “${q}”` : "Nothing to connect to yet."}
                  </div>
                )}
                {groups.map((g) => (
                  <div key={g.key} role="group" aria-label={g.title}>
                    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-text-muted/80">
                      {g.title}
                    </div>
                    {g.rows.map((e) => {
                      const reason = pickReason(e);
                      const checked = isOn(e);
                      return (
                        <Row
                          key={`${e.kind}:${e.id}`}
                          entry={e}
                          viewerId={viewerId}
                          checked={checked}
                          reason={reason}
                          onPick={() => onToggle(e, !checked)}
                        />
                      );
                    })}
                  </div>
                ))}
                {onConnectNew && (
                  <button
                    type="button"
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => {
                      close();
                      onConnectNew();
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 mt-1 border-t border-border/60 text-left text-xs text-primary hover:bg-bg-hover"
                  >
                    <Plus className="w-3.5 h-3.5" /> Connect something new…
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
      {!disabledReason && (
        <p className="text-[11px] text-text-muted/80" data-testid="connected-to-summary">
          {on.length === 0
            ? "Nothing connected."
            : `${on.length} connected${defaultCount > 0 ? ` · ${defaultCount} from ${hasRepo ? "the repo's" : "the"} defaults` : ""}`}
          {struck.length > 0 ? ` · ${struck.length} turned off` : ""}
        </p>
      )}
    </div>
  );
}

function Chip({
  entry,
  viewerId,
  tag,
  struck,
  onRemove,
  onRestore,
  removeTitle,
}: {
  entry: WorkEnvironmentEntry;
  viewerId: string | null;
  tag?: string | null;
  struck?: boolean;
  onRemove?: () => void;
  onRestore?: () => void;
  removeTitle?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 h-7 pl-1 pr-1 rounded-md border text-xs",
        struck
          ? "border-dashed border-border text-text-muted line-through"
          : "bg-primary/10 border-primary/40 text-text",
      )}
      title={entrySubtext(entry, viewerId)}
      data-testid={struck ? "connected-chip-off" : "connected-chip"}
    >
      <ConnectionMark icon={entry.icon} kind={entry.kind} size="sm" />
      <span className="max-w-[12rem] truncate">{entry.name}</span>
      {tag && <span className="text-[10px] text-text-muted no-underline">{tag}</span>}
      {struck ? (
        <button
          type="button"
          onClick={onRestore}
          className="p-0.5 rounded hover:bg-bg-hover hover:text-text"
          aria-label={`Turn ${entry.name} back on`}
          title="Turn back on"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          className="p-0.5 rounded hover:bg-bg-hover hover:text-text"
          aria-label={`Disconnect ${entry.name}`}
          title={removeTitle}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

function Row({
  entry,
  viewerId,
  checked,
  reason,
  onPick,
}: {
  entry: WorkEnvironmentEntry;
  viewerId: string | null;
  checked: boolean;
  reason: string | null;
  onPick: () => void;
}) {
  const disabled = !!reason;
  return (
    <button
      type="button"
      role="option"
      aria-selected={checked}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      title={reason ?? entrySubtext(entry, viewerId)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={disabled ? undefined : onPick}
      className={cn(
        "w-full flex items-center gap-2.5 px-3 py-1.5 text-left transition-colors",
        disabled ? "opacity-50 cursor-not-allowed" : "hover:bg-bg-hover",
      )}
    >
      <ConnectionMark icon={entry.icon} kind={entry.kind} size="md" />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm truncate",
            checked ? "text-primary font-medium" : "text-text-heading",
          )}
        >
          {entry.name}
        </span>
        <span className="block text-[11px] text-text-muted truncate">
          {entrySubtext(entry, viewerId)}
        </span>
      </span>
      {checked && <Check className="w-3.5 h-3.5 text-primary shrink-0" />}
    </button>
  );
}
