"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { ArrowUpCircle, X, Loader2, ExternalLink, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

export function UpdateBanner() {
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [updateInitiated, setUpdateInitiated] = useState(false);
  const previousVersion = useRef<string | null>(null);

  const fetchVersion = useCallback(async () => {
    try {
      const info = await api.getClusterVersion();
      // Detect post-update reconnection: version changed after we triggered an update
      if (updateInitiated && previousVersion.current && info.current !== previousVersion.current) {
        setUpdateInitiated(false);
        setUpdating(false);
        toast.success(`Updated to v${info.current}`);
      }
      previousVersion.current = info.current;
      setVersionInfo(info);
    } catch {
      // Silently fail — version check is not critical
    }
  }, [updateInitiated]);

  useEffect(() => {
    fetchVersion();
  }, [fetchVersion]);

  // Poll more frequently while an update is in progress
  useEffect(() => {
    if (!updateInitiated) return;
    const interval = setInterval(fetchVersion, 10_000);
    // Stop polling after 3 minutes — if still not updated, show failure
    const timeout = setTimeout(() => {
      if (updateInitiated) {
        setUpdating(false);
        setUpdateInitiated(false);
        toast.error("Update may have failed — version has not changed. Check cluster status.", {
          duration: 10_000,
        });
      }
    }, 180_000);
    return () => {
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [updateInitiated, fetchVersion]);

  const handleUpdate = async () => {
    if (!versionInfo?.latest) return;
    setShowConfirm(false);
    setUpdating(true);
    setUpdateInitiated(true);
    previousVersion.current = versionInfo.current;
    try {
      await api.triggerClusterUpdate(versionInfo.latest);
      toast.info("Rolling update initiated. The page will reconnect automatically.");
    } catch (err: any) {
      setUpdating(false);
      setUpdateInitiated(false);
      toast.error(`Update failed: ${err.message}`);
    }
  };

  // Don't show if: no data, no update, dev mode, or dismissed
  if (!versionInfo || !versionInfo.updateAvailable || versionInfo.current === "dev" || dismissed) {
    return null;
  }

  const rollbackCommand = `kubectl rollout undo deployment/optio-api deployment/optio-web -n optio`;

  return (
    <>
      <div className="relative flex items-center gap-3 px-4 py-3 rounded-lg border border-primary/20 bg-primary/5">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          {updating ? (
            <Loader2 className="w-4 h-4 text-primary animate-spin" />
          ) : (
            <ArrowUpCircle className="w-4 h-4 text-primary" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {updating ? (
            <>
              <p className="text-sm text-text">Updating to v{versionInfo.latest}...</p>
              <p className="text-xs text-text-muted mt-0.5">
                The page will reconnect automatically when the update completes.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm text-text">
                Update available:{" "}
                <span className="font-medium text-primary">v{versionInfo.latest}</span>
                <span className="text-text-muted ml-1">(current: v{versionInfo.current})</span>
              </p>
              <p className="text-xs text-text-muted mt-0.5">
                <a
                  href="https://github.com/jonwiggins/optio/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 hover:text-primary transition-colors"
                >
                  View changelog <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </>
          )}
        </div>
        {!updating && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={() => setShowConfirm(true)}
              className="px-3 py-1.5 text-xs font-medium rounded-md bg-primary text-white hover:bg-primary/90 transition-colors"
            >
              Update
            </button>
            <button
              onClick={() => setDismissed(true)}
              className="p-1 rounded hover:bg-bg-hover text-text-muted transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* Confirmation dialog */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-bg-card border border-border rounded-xl shadow-xl max-w-md w-full mx-4 p-6 space-y-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                <ArrowUpCircle className="w-5 h-5 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-text">Confirm Update</h3>
                <p className="text-sm text-text-muted">
                  v{versionInfo.current} &rarr; v{versionInfo.latest}
                </p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="space-y-1.5">
                <p className="text-sm text-text">This will update the following deployments:</p>
                <ul className="text-sm text-text-muted space-y-1 ml-4">
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> optio-api
                  </li>
                  <li className="flex items-center gap-2">
                    <CheckCircle2 className="w-3.5 h-3.5 text-primary" /> optio-web
                  </li>
                </ul>
              </div>

              <div className="p-3 rounded-lg bg-bg/50 border border-border">
                <p className="text-xs text-text-muted mb-1.5">
                  If something goes wrong, roll back with:
                </p>
                <code className="text-xs text-text font-mono break-all">{rollbackCommand}</code>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 text-sm rounded-lg border border-border hover:bg-bg-hover text-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleUpdate}
                className="px-4 py-2 text-sm rounded-lg bg-primary text-white hover:bg-primary/90 transition-colors font-medium"
              >
                Update to v{versionInfo.latest}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
