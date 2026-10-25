"use client";

import { inputClass } from "@/components/ui/input";
import type { RemoteWorkspaceParameter } from "@/lib/api-client";

/**
 * A template's parameters as a form (docs/remote-workspaces.md): a select
 * for one with options, a toggle for a bool, a field for the rest. `values`
 * holds what was typed; a parameter left alone shows `fallback`'s value or
 * the template's default, and isn't sent.
 */
export function WorkspaceParameterFields({
  parameters,
  values,
  fallback = {},
  onChange,
  idPrefix = "workspace-param",
}: {
  parameters: RemoteWorkspaceParameter[];
  values: Record<string, string>;
  /** Values that apply when nothing is typed (the connection's defaults). */
  fallback?: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
  idPrefix?: string;
}) {
  if (parameters.length === 0) return null;
  const set = (name: string, value: string) => onChange({ ...values, [name]: value });
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {parameters.map((p) => {
        const id = `${idPrefix}-${p.name}`;
        const value = values[p.name] ?? fallback[p.name] ?? p.defaultValue ?? "";
        const label = p.displayName || p.name;
        return (
          <div key={p.name}>
            <label htmlFor={id} className="block text-sm text-text-muted mb-1.5">
              {label}
              {p.required && !p.defaultValue ? <span className="text-error"> *</span> : null}
            </label>
            {p.options.length > 0 ? (
              <select
                id={id}
                value={value}
                onChange={(e) => set(p.name, e.target.value)}
                className={inputClass()}
              >
                {!p.options.some((o) => o.value === value) && <option value="">Pick one…</option>}
                {p.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.name}
                  </option>
                ))}
              </select>
            ) : p.type === "bool" ? (
              <label className="flex items-center gap-2 text-sm py-2">
                <input
                  id={id}
                  type="checkbox"
                  checked={value === "true"}
                  onChange={(e) => set(p.name, e.target.checked ? "true" : "false")}
                />
                <span className="text-text-muted">{value === "true" ? "Yes" : "No"}</span>
              </label>
            ) : (
              <input
                id={id}
                type={p.type === "number" ? "number" : "text"}
                value={value}
                onChange={(e) => set(p.name, e.target.value)}
                spellCheck={false}
                className={inputClass()}
              />
            )}
            {p.description && (
              <p className="text-[11px] text-text-muted/80 mt-1 line-clamp-2">{p.description}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
