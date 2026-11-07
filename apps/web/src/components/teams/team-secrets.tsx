"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TeamDetail } from "@optio/shared";
import { api, type VisibleSecret } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/section-card";

/**
 * A team's secrets (docs/teams.md): its work gets them before the
 * organization's, and never its creator's own. `GITLAB_TOKEN` /
 * `GITHUB_TOKEN` here are the tokens the team's work reaches git with.
 * Names only are ever shown; the team's admins and workspace admins add and
 * remove them.
 */
export function TeamSecrets({ team }: { team: TeamDetail }) {
  const [secrets, setSecrets] = useState<VisibleSecret[] | null>(null);
  const [name, setName] = useState("GITLAB_TOKEN");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .listSecrets("team")
      .then((res) => setSecrets(res.secrets.filter((s) => s.teamId === team.id)))
      .catch(() => setSecrets([]));
  }, [team.id]);
  useEffect(load, [load]);

  const add = async () => {
    const n = name.trim();
    if (!n || !value || busy) return;
    setBusy(true);
    try {
      await api.createSecret({ name: n, value, scope: "team", teamId: team.id });
      setValue("");
      toast.success(`Saved ${n} for ${team.name}`);
      load();
    } catch (err) {
      toast.error("Couldn't save", { description: err instanceof Error ? err.message : undefined });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (secret: string) => {
    setBusy(true);
    try {
      await api.deleteSecret(secret, "team", undefined, team.id);
      load();
    } catch (err) {
      toast.error("Couldn't remove", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionCard
      label="Secrets and tokens"
      hint="What the team's work gets before the organization's"
      summary={secrets ? String(secrets.length) : undefined}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        The team&apos;s work uses these first, then the organization&apos;s, and never the personal
        secrets of whoever made it. A <code>GITLAB_TOKEN</code> or <code>GITHUB_TOKEN</code> here is
        what the team&apos;s work clones, pushes and opens pull requests with.
      </p>
      {secrets === null ? (
        <Loader2 className="w-4 h-4 animate-spin text-text-muted" />
      ) : secrets.length === 0 ? (
        <p className="text-xs text-text-muted">No team secrets yet.</p>
      ) : (
        <ul className="space-y-1" data-testid="team-secrets">
          {secrets.map((s) => (
            <li key={s.id} className="flex items-center justify-between text-sm">
              <code>{s.name}</code>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove ${s.name}`}
                disabled={busy}
                onClick={() => void remove(s.name)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <input
          aria-label="Secret name"
          className={inputClass()}
          value={name}
          onChange={(e) => setName(e.target.value.toUpperCase())}
          placeholder="GITLAB_TOKEN"
        />
        <input
          aria-label="Secret value"
          type="password"
          autoComplete="off"
          className={inputClass()}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Value"
        />
        <Button size="sm" disabled={busy || !name.trim() || !value} onClick={() => void add()}>
          <Plus />
          Save
        </Button>
      </div>
    </SectionCard>
  );
}
