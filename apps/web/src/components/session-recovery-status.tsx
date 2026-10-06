"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { RefreshCw, CircleAlert } from "lucide-react";

export function SessionRecoveryStatus({ kind, id }: { kind: "pod" | "local"; id: string }) {
  const [status, setStatus] = useState<{ state: string; message: string } | null>(null);
  useEffect(() => {
    let active = true;
    const refresh = () =>
      api
        .getSessionRecovery(kind, id)
        .then((r) => {
          if (active) setStatus(r);
        })
        .catch(() => {
          if (active)
            setStatus({
              state: "reconnecting",
              message:
                "Reconnecting to Optio. Running work may still be active; no commands are being replayed.",
            });
        });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [kind, id]);
  if (!status || status.state === "live" || status.state === "ended") return null;
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b border-warning/20 bg-warning/5 px-4 py-2.5 text-xs leading-relaxed text-text-muted"
    >
      {status.state === "reconnecting" ? (
        <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
      ) : (
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      )}
      <p>
        <span className="mr-1 font-medium capitalize text-text">{status.state}.</span>
        {status.message}
      </p>
    </div>
  );
}
