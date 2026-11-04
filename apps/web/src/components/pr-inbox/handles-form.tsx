"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import type { PrInboxResponse } from "@optio/shared";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

/** Link the viewer's GitHub (and GitLab) handle, so the panel knows which PRs are theirs. */
export function HandlesForm({
  current,
  suggested,
  showGitLab,
  onSaved,
}: {
  current: PrInboxResponse["viewer"];
  suggested: string | null;
  showGitLab: boolean;
  onSaved: () => void;
}) {
  // Start from what we know or can guess, so the field never just looks filled in.
  const [github, setGithub] = useState(current.handles[0] ?? suggested ?? "");
  const [gitlab, setGitlab] = useState(current.handles[1] ?? "");
  const [busy, setBusy] = useState(false);

  const save = async (gh = github) => {
    setBusy(true);
    try {
      await api.setPrInboxHandles({
        github: gh.trim() || null,
        ...(showGitLab ? { gitlab: gitlab.trim() || null } : {}),
      });
      toast.success("Saved");
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="flex flex-col gap-2 sm:flex-row sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label className="flex flex-col gap-1 text-xs text-text-muted">
        GitHub login
        <span className="relative">
          <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted/70">@</span>
          <input
            value={github}
            onChange={(e) => setGithub(e.target.value)}
            placeholder="your-login"
            aria-label="GitHub login"
            autoComplete="off"
            spellCheck={false}
            className={inputClass({ size: "sm", className: "pl-6 w-full sm:w-56 bg-bg-card" })}
          />
        </span>
      </label>
      {showGitLab && (
        <label className="flex flex-col gap-1 text-xs text-text-muted">
          GitLab username
          <span className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted/70">@</span>
            <input
              value={gitlab}
              onChange={(e) => setGitlab(e.target.value)}
              placeholder="your-username"
              autoComplete="off"
              spellCheck={false}
              className={inputClass({ size: "sm", className: "pl-6 w-full sm:w-56 bg-bg-card" })}
            />
          </span>
        </label>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          type="submit"
          disabled={busy || (!github.trim() && !(showGitLab && gitlab.trim()))}
        >
          {busy && <Loader2 className="animate-spin" />}
          Save
        </Button>
      </div>
    </form>
  );
}
