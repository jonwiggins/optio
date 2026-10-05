"use client";

import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";

/**
 * The setup form of a connection provider, drawn from its `configSchema`
 * (JSON Schema): a password field per `format: "secret"` property, a select
 * per `enum`, a switch per `type: "boolean"`, a textarea for multi-line
 * values, a text input for the rest. In edit mode a saved secret shows as
 * "•••••••• Saved" with a Replace link; a blank replacement keeps the value.
 */

export type ConfigValue = Record<string, unknown>;

export interface SchemaProperty {
  type?: string;
  title?: string;
  description?: string;
  format?: string;
  enum?: unknown[];
  enumTitles?: string[];
  default?: unknown;
}

export interface ConfigSchema {
  properties?: Record<string, SchemaProperty>;
  required?: string[];
}

/** The properties in schema order, as `[key, property]` pairs. */
export function schemaEntries(
  schema: ConfigSchema | null | undefined,
): Array<[string, SchemaProperty]> {
  return Object.entries(schema?.properties ?? {});
}

function isSecret(prop: SchemaProperty): boolean {
  return prop.format === "secret";
}

function isBoolean(prop: SchemaProperty): boolean {
  return prop.type === "boolean";
}

function isMultiline(key: string, prop: SchemaProperty): boolean {
  if (["description", "env", "args"].includes(key)) return true;
  return /one per line/i.test(prop.title ?? "") || /one per line/i.test(prop.description ?? "");
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/**
 * The required keys that have no value yet. A secret that is already saved
 * (`secretFields`) counts as present even when the form holds no value for it.
 */
export function requiredMissing(
  schema: ConfigSchema | null | undefined,
  value: ConfigValue,
  secretFields: readonly string[] = [],
): string[] {
  const props = schema?.properties ?? {};
  return (schema?.required ?? []).filter((key) => {
    const prop = props[key];
    if (prop && isBoolean(prop)) return false;
    if (isSecret(prop ?? {}) && secretFields.includes(key) && isBlank(value[key])) return false;
    return isBlank(value[key]);
  });
}

/** The values a fresh form starts with: every `default`, and the first enum value. */
export function schemaDefaults(schema: ConfigSchema | null | undefined): ConfigValue {
  const out: ConfigValue = {};
  for (const [key, prop] of schemaEntries(schema)) {
    if (prop.default !== undefined) out[key] = prop.default;
    else if (isBoolean(prop)) out[key] = false;
    else if (prop.enum && prop.enum.length > 0) out[key] = prop.enum[0];
  }
  return out;
}

function FieldLabel({
  htmlFor,
  prop,
  name,
  required,
}: {
  htmlFor: string;
  prop: SchemaProperty;
  name: string;
  required: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-xs text-text-muted mb-1">
      {prop.title ? prop.title : <span className="font-mono">{name}</span>}
      {required && (
        <span className="text-error ml-0.5" aria-hidden="true">
          *
        </span>
      )}
    </label>
  );
}

function SecretInput({
  id,
  value,
  onChange,
  saved,
  required,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  /** The connection already holds a value for this secret (edit mode). */
  saved: boolean;
  required: boolean;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const [replacing, setReplacing] = useState(false);
  if (saved && !replacing) {
    return (
      <div className="flex items-center gap-3 text-sm">
        <span className="font-mono text-text-muted tracking-widest">••••••••</span>
        <span className="text-xs text-text-muted">Saved</span>
        <button
          type="button"
          onClick={() => setReplacing(true)}
          className="text-xs text-primary hover:underline"
        >
          Replace
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required && !saved}
        autoComplete="off"
        spellCheck={false}
        placeholder={saved ? "Leave blank to keep the saved value" : placeholder}
        className={cn(inputClass(), "pr-9 font-mono")}
      />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide value" : "Show value"}
        aria-pressed={show}
        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-text-muted hover:text-text"
      >
        {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
}

/** The hand-rolled switch the Connections page uses. */
export function Switch({
  checked,
  onChange,
  label,
  id,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  id?: string;
}) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
        checked ? "bg-primary" : "bg-border",
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-4.5" : "translate-x-1",
        )}
      />
    </button>
  );
}

export function ProviderFields({
  schema,
  value,
  onChange,
  secretFields = [],
  mode,
  idPrefix = "pf",
}: {
  schema: ConfigSchema | null | undefined;
  value: ConfigValue;
  onChange: (next: ConfigValue) => void;
  /** Secret keys the connection already has a value for (edit mode). */
  secretFields?: readonly string[];
  mode: "create" | "edit";
  idPrefix?: string;
}) {
  const required = new Set(schema?.required ?? []);
  const entries = schemaEntries(schema);
  if (entries.length === 0) return null;

  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  return (
    <div className="space-y-3">
      {entries.map(([key, prop]) => {
        const id = `${idPrefix}-${key}`;
        const isReq = required.has(key);
        const str = value[key] === undefined || value[key] === null ? "" : String(value[key]);

        if (isBoolean(prop)) {
          return (
            <div key={key} className="flex items-center justify-between gap-3 py-0.5">
              <div className="min-w-0">
                <label htmlFor={id} className="text-sm text-text">
                  {prop.title ?? <span className="font-mono text-xs">{key}</span>}
                </label>
                {prop.description && (
                  <p className="text-[11px] text-text-muted/80">{prop.description}</p>
                )}
              </div>
              <Switch
                id={id}
                checked={value[key] === true}
                onChange={(v) => set(key, v)}
                label={prop.title ?? key}
              />
            </div>
          );
        }

        let control: React.ReactNode;
        if (isSecret(prop)) {
          control = (
            <SecretInput
              id={id}
              value={str}
              onChange={(v) => set(key, v)}
              saved={mode === "edit" && secretFields.includes(key)}
              required={isReq}
              placeholder={prop.description}
            />
          );
        } else if (prop.enum && prop.enum.length > 0) {
          const current = str !== "" ? str : prop.default !== undefined ? String(prop.default) : "";
          control = (
            <select
              id={id}
              value={current}
              onChange={(e) => set(key, e.target.value)}
              className={inputClass()}
            >
              {!isReq && current === "" && <option value="">—</option>}
              {prop.enum.map((opt, i) => (
                <option key={String(opt)} value={String(opt)}>
                  {prop.enumTitles?.[i] ?? String(opt)}
                </option>
              ))}
            </select>
          );
        } else if (isMultiline(key, prop)) {
          control = (
            <textarea
              id={id}
              value={str}
              onChange={(e) => set(key, e.target.value)}
              rows={3}
              required={isReq}
              placeholder={prop.description}
              className={cn(inputClass(), "font-mono text-xs min-h-[72px]")}
            />
          );
        } else {
          control = (
            <input
              id={id}
              type="text"
              value={str}
              onChange={(e) => set(key, e.target.value)}
              required={isReq}
              placeholder={prop.description}
              autoComplete="off"
              spellCheck={false}
              className={inputClass()}
            />
          );
        }

        return (
          <div key={key}>
            <FieldLabel htmlFor={id} prop={prop} name={key} required={isReq} />
            {control}
          </div>
        );
      })}
    </div>
  );
}

// ── Connected by default ────────────────────────────────────────────────────

/** The agent runtimes a connection can be limited to (same list as the Connections page). */
export const AGENT_TYPES = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Google Gemini" },
  { value: "opencode", label: "OpenCode" },
  { value: "cursor", label: "Cursor" },
] as const;

/** Where a connection is injected by default: every repo, or a chosen few, for some or every agent. */
export interface DefaultAssignments {
  allRepos: boolean;
  repoIds: string[];
  agentTypes: string[];
}

export const ALL_REPOS: DefaultAssignments = { allRepos: true, repoIds: [], agentTypes: [] };

/** The rows `POST`/`PATCH /api/connections` take for a `DefaultAssignments`. */
export function assignmentRows(
  a: DefaultAssignments,
): Array<{ repoId: string | null; agentTypes: string[] }> {
  if (a.allRepos || a.repoIds.length === 0) return [{ repoId: null, agentTypes: a.agentTypes }];
  return a.repoIds.map((repoId) => ({ repoId, agentTypes: a.agentTypes }));
}

/** `DefaultAssignments` from a connection's saved assignment rows (none = all repos). */
export function assignmentsFromRows(
  rows: ReadonlyArray<{ repoId?: string | null; agentTypes?: string[] | null }> | null | undefined,
): DefaultAssignments {
  if (!rows || rows.length === 0) return ALL_REPOS;
  const agentTypes = rows[0].agentTypes ?? [];
  const repoIds = rows.map((r) => r.repoId).filter((id): id is string => !!id);
  if (rows.some((r) => !r.repoId)) return { allRepos: true, repoIds: [], agentTypes };
  return { allRepos: false, repoIds, agentTypes };
}

interface RepoRow {
  id: string;
  name?: string | null;
  fullName?: string | null;
  url?: string | null;
}

function repoLabel(r: RepoRow): string {
  return r.fullName ?? r.name ?? r.url ?? r.id;
}

/**
 * The "Connected by default" block: All repos / Pick repos (a checkbox list
 * from `api.listRepos()`), and agent-type chips (none = every agent).
 */
export function DefaultAssignmentsField({
  value,
  onChange,
}: {
  value: DefaultAssignments;
  onChange: (next: DefaultAssignments) => void;
}) {
  const [repos, setRepos] = useState<RepoRow[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .listRepos()
      .then((res) => {
        if (live) setRepos((res.repos ?? []) as RepoRow[]);
      })
      .catch(() => {
        if (live) setRepos([]);
      });
    return () => {
      live = false;
    };
  }, []);

  const toggleAgent = (agent: string) =>
    onChange({
      ...value,
      agentTypes: value.agentTypes.includes(agent)
        ? value.agentTypes.filter((a) => a !== agent)
        : [...value.agentTypes, agent],
    });
  const toggleRepo = (id: string) =>
    onChange({
      ...value,
      repoIds: value.repoIds.includes(id)
        ? value.repoIds.filter((r) => r !== id)
        : [...value.repoIds, id],
    });

  return (
    <div className="space-y-3">
      <div>
        <span className="block text-xs text-text-muted mb-1">Connected by default</span>
        <Segmented
          aria-label="Connected by default"
          value={value.allRepos ? "all" : "pick"}
          onChange={(v) => onChange({ ...value, allRepos: v === "all" })}
          options={[
            { value: "all", label: "All repos" },
            { value: "pick", label: "Pick repos" },
          ]}
        />
        <p className="text-[11px] text-text-muted/80 mt-1.5">
          Work on these repos gets this connection unless it says otherwise. Jobs and agents pick it
          on their own form.
        </p>
      </div>
      {!value.allRepos && (
        <div className="rounded-lg border border-border max-h-40 overflow-y-auto divide-y divide-border/60">
          {repos === null ? (
            <p className="px-3 py-2 text-xs text-text-muted">Loading repos…</p>
          ) : repos.length === 0 ? (
            <p className="px-3 py-2 text-xs text-text-muted">
              No repos yet — add one under Library.
            </p>
          ) : (
            repos.map((r) => (
              <label
                key={r.id}
                className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer hover:bg-bg-hover"
              >
                <input
                  type="checkbox"
                  checked={value.repoIds.includes(r.id)}
                  onChange={() => toggleRepo(r.id)}
                  className="accent-primary"
                />
                <span className="truncate">{repoLabel(r)}</span>
              </label>
            ))
          )}
        </div>
      )}
      <div>
        <span className="block text-xs text-text-muted mb-1">
          Agents <span className="text-text-muted/50">(none picked = every agent)</span>
        </span>
        <div className="flex flex-wrap gap-2">
          {AGENT_TYPES.map((agent) => {
            const on = value.agentTypes.includes(agent.value);
            return (
              <button
                key={agent.value}
                type="button"
                aria-pressed={on}
                onClick={() => toggleAgent(agent.value)}
                className={cn(
                  "px-2.5 py-1 rounded-md text-xs border transition-colors",
                  on
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-border text-text-muted hover:bg-bg-hover",
                )}
              >
                {agent.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
