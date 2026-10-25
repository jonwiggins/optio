"use client";

import { useState } from "react";
import { Loader2, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TeamDetail, TeamJoinPolicy } from "@optio/shared";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/section-card";
import { JoinPolicyField } from "./new-team-dialog";

/** A team's name, description and join policy (for those who manage it), and the delete. */
export function TeamSettings({
  team,
  onChanged,
  onDeleted,
}: {
  team: TeamDetail;
  onChanged: (team: TeamDetail) => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? "");
  const [joinPolicy, setJoinPolicy] = useState<TeamJoinPolicy>(team.joinPolicy);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const dirty =
    name.trim() !== team.name ||
    (description.trim() || null) !== (team.description ?? null) ||
    joinPolicy !== team.joinPolicy;
  const canSave = dirty && name.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const { team: next } = await api.updateTeam(team.id, {
        name: name.trim(),
        description: description.trim() || null,
        joinPolicy,
      });
      onChanged(next);
      toast.success("Team saved");
    } catch (err) {
      toast.error("Couldn't save the team", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (
      !confirm(
        `Delete ${team.name}? What it owns — its secrets, prompts and work — goes with it. This can't be undone.`,
      )
    )
      return;
    setDeleting(true);
    try {
      await api.deleteTeam(team.id);
      toast.success(`${team.name} deleted`);
      onDeleted();
    } catch (err) {
      setDeleting(false);
      toast.error("Couldn't delete the team", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <SectionCard
      label="Settings"
      actions={
        <Button size="sm" onClick={save} disabled={!canSave}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save
        </Button>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <label htmlFor="team-name" className="block text-sm text-text-muted mb-1.5">
            Name
          </label>
          <input
            id="team-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
            className={inputClass()}
          />
        </div>
        <div>
          <label htmlFor="team-description" className="block text-sm text-text-muted mb-1.5">
            Description
          </label>
          <input
            id="team-description"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the team looks after"
            maxLength={500}
            className={inputClass()}
          />
        </div>
        <JoinPolicyField value={joinPolicy} onChange={setJoinPolicy} />
      </form>
      <div className="mt-6 pt-4 border-t border-border/60 flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-text-muted">Deleting the team deletes what it owns, too.</p>
        <Button size="sm" variant="danger" onClick={remove} disabled={deleting}>
          {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Delete team
        </Button>
      </div>
    </SectionCard>
  );
}
