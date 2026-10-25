"use client";

import { useCallback, useRef, useState } from "react";
import { Users, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { Combobox, type ComboboxOption } from "./combobox";

/**
 * Identity-provider groups, picked: which groups open a workspace, make
 * admins, may sign in, fill a team. The suggestions come from
 * `GET /api/auth/groups` — the LDAP directory's groups (when LDAP is
 * configured) and the groups Optio has seen people sign in with — and a
 * name typed in full is always taken, so a group nobody has signed in with
 * yet (or an OIDC group) works too. Names compare case-insensitively.
 *
 *   <GroupsCombobox label="Admin groups" value={groups} onChange={setGroups} />
 *
 * `search={false}` turns the suggestions off (before anyone can sign in,
 * there is nothing to ask).
 */

/** Split what was typed on commas, trimmed, empties dropped. */
export function splitGroups(text: string): string[] {
  return text
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);
}

/** `current` plus `added`, case-insensitively de-duplicated (the first spelling wins). */
export function addGroups(current: string[], added: string[]): string[] {
  const seen = new Set(current.map((g) => g.toLowerCase()));
  const out = [...current];
  for (const g of added) {
    const key = g.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(g);
  }
  return out;
}

/** The group search the pickers share: the latest answer for the latest query. */
export function useGroupSearch(enabled = true) {
  const [groups, setGroups] = useState<Array<{ name: string; source: "ldap" | "seen" }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const search = useCallback(
    async (q: string) => {
      if (!enabled) return;
      const ticket = ++latest.current;
      setLoading(true);
      try {
        const res = await api.searchGroups(q);
        if (ticket !== latest.current) return;
        setGroups(res.groups);
        setError(res.ldapError ? `The directory couldn't be searched: ${res.ldapError}` : null);
      } catch {
        if (ticket !== latest.current) return;
        setGroups([]);
        setError(null);
      } finally {
        if (ticket === latest.current) setLoading(false);
      }
    },
    [enabled],
  );
  return { groups, loading, error, search };
}

/** A group as a Combobox row, its source as the hint. */
export function groupOption(g: { name: string; source: "ldap" | "seen" }): ComboboxOption {
  return {
    id: g.name.toLowerCase(),
    label: g.name,
    hint: g.source === "ldap" ? "directory" : "seen at sign-in",
  };
}

export function GroupsCombobox({
  id,
  value,
  onChange,
  label,
  placeholder,
  disabled,
  size = "sm",
  search: searchEnabled = true,
  className,
  testId,
}: {
  id?: string;
  value: string[];
  onChange: (next: string[]) => void;
  /** The accessible name. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  size?: "sm" | "md";
  /** Suggest groups from the directory and sign-ins (default on). */
  search?: boolean;
  className?: string;
  testId?: string;
}) {
  const { groups, loading, error, search } = useGroupSearch(searchEnabled);
  const picked = new Set(value.map((g) => g.toLowerCase()));
  const options = groups.filter((g) => !picked.has(g.name.toLowerCase())).map(groupOption);

  const remove = (name: string) => onChange(value.filter((g) => g !== name));

  return (
    <div className={cn("space-y-1.5", className)} data-testid={testId}>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`${label}: picked`}>
          {value.map((g) => (
            <li
              key={g.toLowerCase()}
              className="inline-flex items-center gap-1 rounded-full border border-border bg-bg pl-2 pr-1 py-0.5 text-xs font-mono text-text"
            >
              {g}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove ${g}`}
                  title="Remove"
                  onClick={() => remove(g)}
                  className="rounded-full p-0.5 text-text-muted hover:bg-bg-hover hover:text-text"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <Combobox
        id={id}
        value=""
        options={options}
        onPick={(o) => onChange(addGroups(value, [o.label]))}
        onCommit={(text) => onChange(addGroups(value, splitGroups(text)))}
        onSearch={search}
        freeText
        mono
        size={size}
        loading={loading}
        error={error}
        label={label}
        placeholder={
          placeholder ??
          (searchEnabled
            ? "Search or type a group name"
            : "The group's name, as your directory spells it")
        }
        icon={<Users />}
        disabled={disabled}
        emptyMessage={(q) => (
          <>
            Press Enter to add <span className="font-mono">{q.trim()}</span>
          </>
        )}
      />
    </div>
  );
}
