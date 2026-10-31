"use client";

import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { toast } from "sonner";
import { TEAM_JOIN_POLICY_LABEL, type TeamDetail, type TeamJoinPolicy } from "@optio/shared";
import { api } from "@/lib/api-client";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { JOIN_POLICY_SHORT } from "./standing";

const POLICIES: TeamJoinPolicy[] = ["open", "request", "closed"];

/** The join-policy pills, shared by the New team dialog and a team's settings. */
export function JoinPolicyField({
  value,
  onChange,
  size = "sm",
}: {
  value: TeamJoinPolicy;
  onChange: (v: TeamJoinPolicy) => void;
  size?: "sm" | "md";
}) {
  return (
    <div>
      <span className="block text-sm text-text-muted mb-1.5">Who can join</span>
      <Segmented
        wrap
        size={size}
        aria-label="Who can join"
        value={value}
        onChange={onChange}
        options={POLICIES.map((p) => ({ value: p, label: JOIN_POLICY_SHORT[p] }))}
      />
      <p className="text-[11px] text-text-muted/80 mt-1.5">{TEAM_JOIN_POLICY_LABEL[value]}</p>
    </div>
  );
}

/** "New team": a name, a line about it, and who can join. The creator becomes its first admin. */
export function NewTeamDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (team: TeamDetail) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [joinPolicy, setJoinPolicy] = useState<TeamJoinPolicy>("request");
  const [saving, setSaving] = useState(false);
  const canSave = name.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const { team } = await api.createTeam({
        name: name.trim(),
        description: description.trim() || null,
        joinPolicy,
      });
      toast.success(`${team.name} created`);
      onCreated(team);
    } catch (err) {
      setSaving(false);
      toast.error("Couldn't create the team", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <Dialog
      title="New team"
      description="A team shares its work and secrets with its members. You become its first admin."
      onClose={onClose}
      busy={saving}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSave}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Create team
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div>
          <label htmlFor="new-team-name" className="block text-sm text-text-muted mb-1.5">
            Name
          </label>
          <input
            id="new-team-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Platform"
            maxLength={80}
            autoFocus
            className={inputClass()}
          />
        </div>
        <div>
          <label htmlFor="new-team-description" className="block text-sm text-text-muted mb-1.5">
            Description
          </label>
          <input
            id="new-team-description"
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
    </Dialog>
  );
}
