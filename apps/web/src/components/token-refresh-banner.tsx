"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { AlertTriangle, Check, Copy, ExternalLink, Key, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

const COPY_COMMAND = `security find-generic-password -s "Claude Code-credentials" -w | python3 -c "import sys,json; print(json.load(sys.stdin)['claudeAiOauth']['accessToken'])" | pbcopy`;

// Module-level presence registry so the global top-of-page banner can hide
// itself whenever a full inline widget is mounted on the current page.
let mountedCount = 0;
const listeners = new Set<() => void>();
function emit() {
  for (const l of listeners) l();
}
export function useIsTokenRefreshBannerMounted() {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => mountedCount > 0,
    () => false,
  );
}

export function TokenRefreshBanner({ onSaved }: { onSaved?: () => void | Promise<void> } = {}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    mountedCount++;
    emit();
    return () => {
      mountedCount--;
      emit();
    };
  }, []);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      const result = await api.createSecret({
        name: "CLAUDE_CODE_OAUTH_TOKEN",
        value: token.trim(),
        scope: "user",
      });
      if (result.validation && !result.validation.valid) {
        toast.error(`Token saved but validation failed: ${result.validation.error}`);
      } else {
        toast.success("Token updated — tasks will use it on next run");
        // Directly trigger a usage refetch so the banner dismisses without
        // waiting on the WebSocket event or the 5-minute poll. If validation
        // failed we leave the banner up so the user can try again.
        await onSaved?.();
      }
      setToken("");
    } catch {
      toast.error("Failed to save token");
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-warning/30 bg-warning/5 p-4 space-y-2">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-text-heading">Claude OAuth token expired</div>
          <div className="text-xs text-text-muted mt-0.5">
            Tasks will fail until a new token is provided.
          </div>
        </div>
      </div>

      <div className="p-2.5 rounded-md bg-bg/50 border border-border">
        <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
          1. Copy your token
        </div>
        <div className="relative group">
          <pre className="text-[11px] text-text/80 whitespace-pre-wrap font-mono bg-bg-card rounded px-2.5 py-2 border border-border select-all break-all">
            {COPY_COMMAND}
          </pre>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(COPY_COMMAND);
              toast.success("Command copied");
            }}
            className="absolute top-1 right-1 p-1 rounded bg-bg-hover text-text-muted hover:text-text opacity-0 group-hover:opacity-100 transition-opacity"
          >
            <Copy className="w-3 h-3" />
          </button>
        </div>
      </div>

      <div className="p-2.5 rounded-md bg-bg/50 border border-border">
        <div className="text-[10px] uppercase tracking-wider text-text-muted mb-1.5">
          2. Paste new token
        </div>
        <div className="flex gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste token here"
            className="flex-1 px-2.5 py-1.5 rounded-md bg-bg border border-border text-xs font-mono focus:outline-none focus:border-primary"
          />
          <button
            onClick={handleSave}
            disabled={!token.trim() || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs hover:bg-primary-hover disabled:opacity-50 btn-press transition-all"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Key className="w-3 h-3" />}
            Update
          </button>
        </div>
      </div>
    </div>
  );
}

export function GitHubTokenBanner({ onSaved }: { onSaved?: () => void | Promise<void> } = {}) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!token.trim()) return;
    setSaving(true);
    try {
      const result = await api.createSecret({ name: "GITHUB_TOKEN", value: token.trim() });
      const validation = (result as any).validation;
      if (validation && !validation.valid) {
        toast.error(`Token saved but validation failed: ${validation.error}`);
      } else {
        toast.success("GitHub token updated");
        // Directly trigger a usage refetch so the banner dismisses without
        // waiting on the WebSocket event or the 5-minute poll. If validation
        // failed we leave the banner up so the user can try again.
        await onSaved?.();
      }
      setToken("");
    } catch {
      toast.error("Failed to save token");
    }
    setSaving(false);
  };

  return (
    <div className="rounded-xl border border-error/30 bg-error/5 p-4 space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-error shrink-0" />
        <span className="text-sm font-medium text-text-heading">GitHub token invalid</span>
        <span className="text-xs text-text-muted">— ticket sync and PR watching are failing</span>
      </div>

      <a
        href="https://github.com/settings/tokens/new?scopes=repo,read:org&description=Optio+Agent"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-bg-hover text-text text-sm hover:bg-border transition-colors"
      >
        <ExternalLink className="w-4 h-4" />
        Create GitHub Personal Access Token
      </a>

      <div className="flex items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="Paste GitHub token here"
          className="flex-1 px-3 py-1.5 rounded-md bg-bg border border-border text-sm focus:outline-none focus:border-primary font-mono"
        />
        <button
          onClick={handleSave}
          disabled={!token.trim() || saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? (
            "Saving..."
          ) : token.trim() ? (
            <>
              <Check className="w-3 h-3" />
              Save Token
            </>
          ) : (
            "Save Token"
          )}
        </button>
      </div>
    </div>
  );
}
