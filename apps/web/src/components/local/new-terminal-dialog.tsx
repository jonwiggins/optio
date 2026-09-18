"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Loader2, Terminal, X } from "lucide-react";

const AGENTS = ["claude-code", "codex", "cursor", "gemini", "opencode"] as const;
type SpecKind = "shell" | "command" | "agent";

export function NewTerminalDialog({ hosts, onClose }: { hosts: any[]; onClose: () => void }) {
  const router = useRouter();
  const onlineHosts = useMemo(() => hosts.filter((h) => h.state === "online"), [hosts]);
  const [hostId, setHostId] = useState(onlineHosts[0]?.id ?? hosts[0]?.id ?? "");
  const host = hosts.find((h) => h.id === hostId);
  const [dir, setDir] = useState("");
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<SpecKind>("shell");
  const [command, setCommand] = useState("");
  const [agent, setAgent] = useState<(typeof AGENTS)[number]>("claude-code");
  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);

  const effectiveDir = dir || host?.dirs?.[0]?.path || "";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handleCreate = async () => {
    if (!hostId || !effectiveDir) {
      toast.error("Pick a host and directory");
      return;
    }
    if (kind === "command" && !command.trim()) {
      toast.error("Enter a command to run");
      return;
    }
    setCreating(true);
    try {
      const spec =
        kind === "shell"
          ? ({ kind: "shell" } as const)
          : kind === "command"
            ? ({ kind: "command", command: command.trim() } as const)
            : ({ kind: "agent", agent, prompt: prompt.trim() || undefined } as const);
      const res = await api.createLocalTerminal({
        hostId,
        dir: effectiveDir,
        title: title.trim() || undefined,
        spec,
      });
      if (host?.state === "online") toast.success("Terminal spawned");
      else toast.success(`Queued — starts when ${host?.name ?? "the host"} reconnects`);
      router.push(`/local/${res.terminal.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to spawn terminal");
      setCreating(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-terminal-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void handleCreate();
        }}
        className="bg-bg-card border border-border rounded-xl p-5 w-full max-w-lg shadow-xl"
      >
        <div className="flex items-center justify-between mb-4">
          <h2 id="new-terminal-title" className="flex items-center gap-2 text-sm font-semibold">
            <Terminal className="w-4 h-4 text-primary" />
            New Terminal
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-text-muted hover:text-text transition-colors"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Host</label>
              <select
                autoFocus
                value={hostId}
                onChange={(e) => {
                  setHostId(e.target.value);
                  setDir("");
                }}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
              >
                {hosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} {h.state === "offline" ? "(offline)" : ""}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">Directory</label>
              <select
                value={effectiveDir}
                onChange={(e) => setDir(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
              >
                {(host?.dirs ?? []).map((d: any) => (
                  <option key={d.path} value={d.path}>
                    {d.path}
                  </option>
                ))}
              </select>
              {host && (host.dirs ?? []).length === 0 && (
                <p className="text-[11px] text-text-muted/70 mt-1">
                  No dirs on this host — run{" "}
                  <code className="font-mono">optio local add &lt;dir&gt;</code> there.
                </p>
              )}
            </div>
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1">
              Title <span className="text-text-muted/60">(optional)</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. fix flaky tests"
              className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
            />
          </div>

          <div>
            <label className="block text-xs text-text-muted mb-1.5">Run</label>
            <div className="flex gap-1.5 p-1 rounded-lg bg-bg border border-border w-fit">
              {(["shell", "command", "agent"] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={cn(
                    "px-3 py-1.5 rounded-md text-xs capitalize transition-colors",
                    kind === k ? "bg-primary text-white" : "text-text-muted hover:text-text",
                  )}
                >
                  {k}
                </button>
              ))}
            </div>
          </div>

          {kind === "command" && (
            <div>
              <label className="block text-xs text-text-muted mb-1">Command</label>
              <input
                type="text"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="e.g. pnpm test --watch"
                className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm font-mono focus:outline-none focus:border-primary"
              />
            </div>
          )}

          {kind === "agent" && (
            <>
              <div>
                <label className="block text-xs text-text-muted mb-1">Agent</label>
                <select
                  value={agent}
                  onChange={(e) => setAgent(e.target.value as (typeof AGENTS)[number])}
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary"
                >
                  {AGENTS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Prompt <span className="text-text-muted/60">(optional)</span>
                </label>
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={3}
                  placeholder="What should the agent do?"
                  className="w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary resize-y"
                />
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-xs font-medium bg-bg border border-border text-text-muted hover:text-text transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={creating || !hostId || !effectiveDir}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
          >
            {creating ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Terminal className="w-3 h-3" />
            )}
            Spawn
          </button>
        </div>
      </form>
    </div>
  );
}
