"use client";

import { useEffect, useMemo } from "react";
import { Laptop, Loader2, MessageSquare, Server, Square } from "lucide-react";
import { normalizeRepoUrl, toLocalAgentKind } from "@optio/shared";
import { cn } from "@/lib/utils";
import { useLocalHosts } from "@/hooks/use-local-hosts";

/**
 * Where a Task / Job runs: an Optio-managed pod, or a directory on one of the
 * user's own machines (Optio Local). The same picker backs the New Task
 * form, the Job editor, and the scheduled Task editor, so "run location" is
 * one concept everywhere. Local runs need a paired host (`optio local up`).
 */

export type RunTarget = "cluster" | "local";
export type LocalSessionMode = "headless" | "interactive";

export interface RunLocationValue {
  runTarget: RunTarget;
  /** Local only: `local_hosts.id`. */
  localHostId: string;
  /** Local only: an allowlisted directory on the host. */
  localDir: string;
  /** Local only: exit when the agent's turn is done, or keep the session open. */
  localSessionMode: LocalSessionMode;
}

export const CLUSTER_RUN_LOCATION: RunLocationValue = {
  runTarget: "cluster",
  localHostId: "",
  localDir: "",
  localSessionMode: "headless",
};

/** Read a persisted row (job / task / task config) back into picker state. */
export function runLocationFromRow(
  row:
    | {
        runTarget?: string | null;
        localHostId?: string | null;
        localDir?: string | null;
        localSessionMode?: string | null;
      }
    | null
    | undefined,
): RunLocationValue {
  if (!row || row.runTarget !== "local") return CLUSTER_RUN_LOCATION;
  return {
    runTarget: "local",
    localHostId: row.localHostId ?? "",
    localDir: row.localDir ?? "",
    localSessionMode: row.localSessionMode === "interactive" ? "interactive" : "headless",
  };
}

/** The fields an API create / update body carries for a location. */
export function runLocationPayload(value: RunLocationValue) {
  if (value.runTarget !== "local") {
    return {
      runTarget: "cluster" as const,
      localHostId: null,
      localDir: null,
      localSessionMode: null,
    };
  }
  return {
    runTarget: "local" as const,
    localHostId: value.localHostId,
    localDir: value.localDir,
    localSessionMode: value.localSessionMode,
  };
}

/** Agent runtimes the local daemon can launch (the picker's parent filters its agent list with this). */
export function agentRunsLocally(agentType: string | null | undefined): boolean {
  return toLocalAgentKind(agentType) !== null;
}

function sameRepo(a: string | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  try {
    return normalizeRepoUrl(a) === normalizeRepoUrl(b);
  } catch {
    return a === b;
  }
}

export function RunLocationPicker({
  value,
  onChange,
  kind,
  agentType,
  repoUrl,
  className,
}: {
  value: RunLocationValue;
  onChange: (next: RunLocationValue) => void;
  /** Copy: a Task opens a PR from a checkout; a Job just runs. */
  kind: "task" | "job";
  /** The agent picked elsewhere in the form, to warn when it can't run locally. */
  agentType?: string;
  /** Tasks: preselect the checkout of this repo and flag other checkouts. */
  repoUrl?: string | null;
  className?: string;
}) {
  const { hosts, loading } = useLocalHosts();
  const host = useMemo(
    () => hosts.find((h) => h.id === value.localHostId),
    [hosts, value.localHostId],
  );
  const dirs: Array<{ path: string; repoUrl?: string }> = host?.dirs ?? [];
  const isLocal = value.runTarget === "local";
  const noHosts = !loading && hosts.length === 0;

  // Adopt a host / directory once the list is known: the first online host,
  // and for a Task the directory whose git remote is the task's repo.
  useEffect(() => {
    if (!isLocal || hosts.length === 0) return;
    const pickedHost = hosts.find((h) => h.id === value.localHostId)
      ? value.localHostId
      : (hosts.find((h) => h.state === "online") ?? hosts[0]).id;
    const hostRow = hosts.find((h) => h.id === pickedHost);
    const hostDirs: Array<{ path: string; repoUrl?: string }> = hostRow?.dirs ?? [];
    let pickedDir = hostDirs.some((d) => d.path === value.localDir) ? value.localDir : "";
    if (
      !pickedDir ||
      (repoUrl && !sameRepo(repoUrl, hostDirs.find((d) => d.path === pickedDir)?.repoUrl))
    ) {
      const match = repoUrl ? hostDirs.find((d) => sameRepo(repoUrl, d.repoUrl)) : undefined;
      pickedDir = match?.path ?? (repoUrl ? pickedDir : "") ?? "";
      if (!pickedDir && !repoUrl) pickedDir = hostDirs[0]?.path ?? "";
    }
    if (pickedHost !== value.localHostId || pickedDir !== value.localDir) {
      onChange({ ...value, localHostId: pickedHost, localDir: pickedDir });
    }
  }, [isLocal, hosts, repoUrl, value.localHostId, value.localDir]);

  const agentBlocked = isLocal && !!agentType && !agentRunsLocally(agentType);
  const dirMismatch =
    isLocal && !!repoUrl && !!value.localDir
      ? (() => {
          const d = dirs.find((x) => x.path === value.localDir);
          return d?.repoUrl && !sameRepo(repoUrl, d.repoUrl) ? d.repoUrl : null;
        })()
      : null;

  return (
    <div className={cn("space-y-3", className)}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <LocationCard
          active={!isLocal}
          onClick={() => onChange({ ...value, runTarget: "cluster" })}
          icon={<Server className="w-4 h-4" />}
          title="Optio pod"
          description={
            kind === "task"
              ? "An isolated Kubernetes pod clones the repo into a fresh worktree. Uses the server's agent credentials."
              : "An isolated Kubernetes pod with no repo checkout. Uses the server's agent credentials and Connections."
          }
        />
        <LocationCard
          active={isLocal}
          onClick={() => onChange({ ...value, runTarget: "local" })}
          icon={<Laptop className="w-4 h-4" />}
          title="My machine"
          description={
            kind === "task"
              ? "Your own checkout on a paired machine, with your local agent CLI and its login. The agent works on a branch and opens the PR from there."
              : "A directory on a paired machine, with your local agent CLI and its login. The session shows up under Local too."
          }
          disabled={noHosts}
          hint={
            noHosts ? (
              <>
                No paired machines. Run <code className="font-mono">optio login</code> then{" "}
                <code className="font-mono">optio local up</code> on your machine.
              </>
            ) : loading && hosts.length === 0 ? (
              <span className="inline-flex items-center gap-1">
                <Loader2 className="w-3 h-3 animate-spin" /> Looking for your machines…
              </span>
            ) : null
          }
        />
      </div>

      {isLocal && (
        <div className="p-4 rounded-lg border border-border bg-bg-card/60 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Machine</label>
              <select
                value={value.localHostId}
                onChange={(e) => onChange({ ...value, localHostId: e.target.value, localDir: "" })}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                    {h.state === "offline" ? " (offline)" : ""}
                  </option>
                ))}
              </select>
              {host?.state === "offline" && (
                <p className="text-[11px] text-text-muted/80 mt-1">
                  Offline — runs wait in the queue until this machine reconnects.
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm text-text-muted mb-1.5">Directory</label>
              <select
                value={value.localDir}
                onChange={(e) => onChange({ ...value, localDir: e.target.value })}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
              >
                {!value.localDir && <option value="">Pick a directory…</option>}
                {dirs.map((d) => {
                  const other = !!repoUrl && !!d.repoUrl && !sameRepo(repoUrl, d.repoUrl);
                  return (
                    <option key={d.path} value={d.path} disabled={other}>
                      {d.path}
                      {other ? " (another repo)" : ""}
                    </option>
                  );
                })}
              </select>
              {host && dirs.length === 0 && (
                <p className="text-[11px] text-text-muted/80 mt-1">
                  No directories on this machine — run{" "}
                  <code className="font-mono">optio local add &lt;dir&gt;</code> there.
                </p>
              )}
              {kind === "task" && host && dirs.length > 0 && !value.localDir && (
                <p className="text-[11px] text-warning mt-1">
                  None of this machine's directories is a checkout of the selected repo.
                </p>
              )}
              {dirMismatch && (
                <p className="text-[11px] text-error mt-1">
                  This directory is a checkout of {dirMismatch}, not the selected repo.
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-sm text-text-muted mb-1.5">Then</label>
            <div className="flex gap-1.5 p-1 rounded-lg bg-bg border border-border w-fit">
              {(
                [
                  ["headless", Square, "Exit when done"],
                  ["interactive", MessageSquare, "Keep the session open"],
                ] as Array<[LocalSessionMode, typeof Square, string]>
              ).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onChange({ ...value, localSessionMode: mode })}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors",
                    value.localSessionMode === mode
                      ? "bg-primary text-white"
                      : "text-text-muted hover:text-text",
                  )}
                >
                  <Icon className="w-3 h-3" />
                  {label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted/80 mt-1.5">
              {value.localSessionMode === "headless"
                ? "The agent runs one turn in print mode and the run finishes when it exits. You can still resume the session as a chat afterwards."
                : 'The agent stays at its prompt after the turn; the run keeps going until you close the session, and it lands in your "needs you" queue.'}
            </p>
          </div>

          {agentBlocked && (
            <p className="text-xs text-error">
              {agentType} can't run on your machine — choose Claude Code, Codex, Cursor, Gemini, or
              OpenCode.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function LocationCard({
  active,
  onClick,
  icon,
  title,
  description,
  disabled,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled?: boolean;
  hint?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      aria-pressed={active}
      className={cn(
        "p-3 rounded-lg border text-left transition-all",
        active
          ? "border-primary bg-primary/5"
          : disabled
            ? "border-border bg-bg-card/40 opacity-60 cursor-not-allowed"
            : "border-border bg-bg-card hover:border-primary/40 cursor-pointer",
      )}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className={cn(active ? "text-primary" : "text-text-muted")}>{icon}</span>
        <span className="text-sm font-medium">{title}</span>
      </div>
      <p className="text-xs text-text-muted leading-relaxed">{description}</p>
      {hint && <p className="text-[11px] text-text-muted mt-2">{hint}</p>}
    </button>
  );
}
