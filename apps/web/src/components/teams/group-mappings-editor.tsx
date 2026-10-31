"use client";
import { qualifiedGroupLabel, qualifiedGroupParts } from "@optio/shared";

import { useState } from "react";
import { Loader2, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { TeamDetail, TeamGroupMapping, TeamRole } from "@optio/shared";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { groupOption, useGroupSearch } from "@/components/ui/groups-combobox";
import { inputClass } from "@/components/ui/input";
import { SectionCard } from "@/components/ui/section-card";

/**
 * Which identity-provider groups fill the team (for those who manage it):
 * one row per group name with the role it gives. Saved as a whole set
 * (`PUT /api/teams/:id/groups`). Rows are compared case-insensitively on the
 * server, and only rows with a name are sent.
 */

/** The rows worth sending: named, trimmed, first spelling of a name wins. */
export function cleanMappings(rows: TeamGroupMapping[]): TeamGroupMapping[] {
  const seen = new Set<string>();
  const out: TeamGroupMapping[] = [];
  for (const r of rows) {
    const groupName = r.groupName.trim();
    const key = groupName.toLowerCase();
    if (!groupName || seen.has(key)) continue;
    seen.add(key);
    out.push({ groupName, role: r.role });
  }
  return out;
}

function sameMappings(a: TeamGroupMapping[], b: TeamGroupMapping[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.groupName === b[i].groupName && m.role === b[i].role);
}

export function GroupMappingsEditor({
  team,
  onChanged,
}: {
  team: TeamDetail;
  onChanged: (team: TeamDetail) => void;
}) {
  const saved = team.groupMappings ?? [];
  const [rows, setRows] = useState<TeamGroupMapping[]>(() =>
    saved.length > 0 ? saved : [{ groupName: "", role: "member" }],
  );
  const [saving, setSaving] = useState(false);
  const dirty = !sameMappings(cleanMappings(rows), saved);
  // The directory's groups and the ones seen at sign-in, for every row.
  const groupSearch = useGroupSearch();

  const setRow = (i: number, patch: Partial<TeamGroupMapping>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = async () => {
    setSaving(true);
    try {
      const { team: next } = await api.setTeamGroupMappings(team.id, cleanMappings(rows));
      onChanged(next);
      const kept = next.groupMappings ?? [];
      setRows(kept.length > 0 ? kept : [{ groupName: "", role: "member" }]);
      toast.success("Group mappings saved");
    } catch (err) {
      toast.error("Couldn't save the group mappings", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <SectionCard
      label="SSO groups"
      hint="fill the team from the identity provider"
      actions={
        <Button size="sm" onClick={save} disabled={saving || !dirty}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save
        </Button>
      }
    >
      <p className="text-xs text-text-muted mb-3">
        People in these groups join the team when they sign in, with the role the row gives (admin
        wins when several match), and leave it again when they&apos;re no longer in the group.
        Members added by hand are never touched. Group names come from the identity provider&apos;s
        group claim or the LDAP directory (Settings → Sign-in). Pick the group with its provider and
        authority; legacy bare names must be reselected.
      </p>
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Combobox
              label={`Group ${i + 1}`}
              value={qualifiedGroupLabel(r.groupName)}
              options={groupSearch.groups.map((g) => groupOption(g))}
              onSearch={groupSearch.search}
              onPick={(o) => setRow(i, { groupName: o.id })}
              onCommit={(text) => {
                if (qualifiedGroupParts(text)) setRow(i, { groupName: text });
              }}
              onClear={() => setRow(i, { groupName: "" })}
              freeText={false}
              mono
              size="sm"
              loading={groupSearch.loading}
              error={groupSearch.error}
              placeholder="engineering-platform"
              emptyMessage={(q) => `Press Enter to use “${q.trim()}”`}
              className="flex-1 min-w-[12rem]"
            />
            <select
              aria-label={`Role for group ${i + 1}`}
              value={r.role}
              onChange={(e) => setRow(i, { role: e.target.value as TeamRole })}
              className={inputClass({ size: "sm", className: "w-auto" })}
            >
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button
              type="button"
              aria-label={`Remove group ${i + 1}`}
              title="Remove"
              onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((_, j) => j !== i) : rs))}
              disabled={rows.length <= 1 && !r.groupName}
              className="p-1.5 rounded-md hover:bg-error/10 text-text-muted hover:text-error transition-colors disabled:opacity-40"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setRows((rs) => [...rs, { groupName: "", role: "member" }])}
        className="mt-3 inline-flex items-center gap-1 text-xs text-primary hover:underline"
      >
        <Plus className="w-3 h-3" />
        Add a group
      </button>
    </SectionCard>
  );
}
