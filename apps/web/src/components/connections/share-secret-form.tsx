"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api, type SecretSharingOverview } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

/**
 * A deployment admin's "Share with workspaces" for one of the deployment's
 * secrets: every workspace, or chosen ones. Unshared (the default), only the
 * founding workspace's work uses it by name. Workspace admins of a workspace
 * it is shared with see its name and that it is shared, never its value; a
 * secret of their own with the same name wins.
 */
export function ShareSecretForm({
  name,
  onClose,
  onSaved,
}: {
  name: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [overview, setOverview] = useState<SecretSharingOverview | null>(null);
  const [all, setAll] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  // Loaded once per secret, however often the row re-renders.
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    let live = true;
    api
      .getSecretSharing()
      .then((o) => {
        if (!live) return;
        const mine = o.secrets.find((s) => s.name === name);
        setOverview(o);
        setAll(mine?.all ?? false);
        setChosen(new Set(mine?.workspaceIds ?? []));
      })
      .catch((err) => {
        toast.error(`Couldn't load who ${name} is shared with`, {
          description: err instanceof Error ? err.message : String(err),
        });
        close.current();
      });
    return () => {
      live = false;
    };
  }, [name]);

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.setSecretSharing(name, { all, workspaceIds: [...chosen] });
      toast.success(all || chosen.size > 0 ? `Shared ${name}` : `${name} is no longer shared`);
      onSaved();
    } catch (err) {
      toast.error(`Couldn't share ${name}`, {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  if (!overview) {
    return (
      <p className="px-4 pb-3 pl-[4.25rem] text-xs text-text-muted flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…
      </p>
    );
  }

  return (
    <form
      onSubmit={save}
      className="px-4 pb-3 pl-[4.25rem] space-y-2 text-sm"
      aria-label={`Share ${name}`}
    >
      <p className="text-xs text-text-muted">
        Work in a workspace you share it with can use {name} by name. Its admins see the name, never
        the value, and a secret of their own with the same name wins.
      </p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={all}
          disabled={!overview.allApplies && !all}
          onChange={(e) => setAll(e.target.checked)}
        />
        Every workspace, including ones created later
      </label>
      {!overview.allApplies && (
        <p className="text-xs text-text-muted">
          Sharing with every workspace needs workspace creation limited to deployment admins
          (Settings → Access); until then, choose workspaces.
        </p>
      )}
      {!all && (
        <fieldset className="space-y-1 max-h-48 overflow-y-auto">
          <legend className="text-xs text-text-muted mb-1">Workspaces</legend>
          {overview.workspaces.map((w) => (
            <label key={w.id} className="flex items-center gap-2">
              <input type="checkbox" checked={chosen.has(w.id)} onChange={() => toggle(w.id)} />
              {w.name}
            </label>
          ))}
        </fieldset>
      )}
      <div className="flex gap-2 pt-1">
        <Button type="submit" size="sm" disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Save
        </Button>
        <Button variant="secondary" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
