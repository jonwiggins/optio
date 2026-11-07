"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  api,
  type SharedGitTokenRule,
  type SharedGitTokenSettings as SharedGitTokenSettingsView,
} from "@/lib/api-client";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Button } from "@/components/ui/button";
import { MONO_AREA } from "@/components/settings/settings-ui";

/**
 * Settings → Access → Shared git token (docs/repo-access.md): use the
 * deployment's own git credentials (the GitHub App, the organization's
 * GITHUB_TOKEN / GITLAB_TOKEN) only for repos listed here per workspace.
 * Off by default. Saved here, the switch wins over the deployment's own
 * default (`OPTIO_SHARED_GIT_TOKEN_RESTRICTED`, chart
 * `sharedGitToken.restricted`); "Follow the deployment" removes the saved
 * value. Shown to deployment admins only; the API refuses anyone else.
 */

type Choice = "on" | "off" | "deployment";

/** The allowlist as text: one `workspace-slug pattern` per line. */
export function rulesToText(rules: SharedGitTokenRule[]): string {
  return rules.map((r) => `${r.workspace} ${r.pattern}`).join("\n");
}

/** Parse the text back; a line that isn't `workspace pattern` is returned in `bad`. */
export function textToRules(text: string): { rules: SharedGitTokenRule[]; bad: string[] } {
  const rules: SharedGitTokenRule[] = [];
  const bad: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    if (parts.length !== 2) bad.push(line);
    else rules.push({ workspace: parts[0], pattern: parts[1] });
  }
  return { rules, bad };
}

export function SharedGitTokenSettings() {
  const [sw, setSw] = useState<SharedGitTokenSettingsView | null>(null);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getDeploymentSettings()
      .then((s) => (s.canEdit ? api.getSharedGitToken() : null))
      .then((next) => {
        if (!next) return;
        setSw(next);
        setText(rulesToText(next.repos));
      })
      .catch(() => {});
  }, []);

  if (!sw) return null;
  const choice: Choice = sw.source === "app" ? (sw.value ? "on" : "off") : "deployment";
  const saved = rulesToText(sw.repos);

  const save = async (data: Parameters<typeof api.updateSharedGitToken>[0]) => {
    setSaving(true);
    try {
      const next = await api.updateSharedGitToken(data);
      setSw(next);
      setText(rulesToText(next.repos));
      toast.success("Saved");
    } catch (err) {
      toast.error("Couldn't save", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      setSaving(false);
    }
  };

  const pick = (next: Choice) => {
    if (saving || next === choice) return;
    void save({ restricted: next === "deployment" ? null : next === "on" });
  };

  const saveRules = () => {
    const { rules, bad } = textToRules(text);
    if (bad.length) {
      toast.error("Couldn't save", {
        description: `Write each line as "workspace-slug pattern": ${bad[0]}`,
      });
      return;
    }
    void save({ repos: rules });
  };

  return (
    <SectionCard
      label="Shared git token"
      hint="Which repos the organization's git token may be used for"
      summary={sw.value ? "Allowed repos only" : "Every repo"}
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        By default the organization&apos;s git credentials (the GitHub App, a GITHUB_TOKEN or
        GITLAB_TOKEN kept by a deployment admin) are the fallback for every repository, so any
        workspace admin can add a repository and have agents read and push it with them. With
        &quot;Allowed repos only&quot;, they are used only for the repositories listed below for
        each workspace. Everything else needs a person&apos;s own token or the workspace&apos;s own
        token, which the git host itself authorizes.
      </p>
      <div data-testid="shared-git-token-switch">
        <Segmented
          value={choice}
          onChange={(next) => pick(next)}
          aria-label="Use the shared git token for"
          options={[
            { value: "off", label: "Every repo" },
            { value: "on", label: "Allowed repos only" },
            {
              value: "deployment",
              label: `Follow the deployment (${sw.environment ? "allowed repos only" : "every repo"})`,
            },
          ]}
        />
      </div>
      <label className="block space-y-1.5">
        <span className="text-xs font-medium text-text">Allowed repositories</span>
        <span className="block text-xs text-text-muted">
          One per line: a workspace slug and a pattern. <code>host/group/repo</code> is one
          repository, <code>host/group/*</code> everything below the group, <code>*</code> every
          repository.
        </span>
        <textarea
          className={MONO_AREA}
          rows={5}
          value={text}
          placeholder={
            "platform gitlab.example.com/platform/*\nteam-a gitlab.example.com/team-a/app"
          }
          aria-label="Allowed repositories"
          onChange={(e) => setText(e.target.value)}
        />
      </label>
      <div className="flex justify-end">
        <Button size="sm" disabled={saving || text.trim() === saved} onClick={saveRules}>
          Save allowed repositories
        </Button>
      </div>
    </SectionCard>
  );
}
