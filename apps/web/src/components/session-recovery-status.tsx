"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { RefreshCw, CircleAlert } from "lucide-react";
import type { ConnState } from "./local/conn-state";

export function SessionRecoveryStatus({
  kind,
  id,
  stream,
}: {
  kind: "pod" | "local";
  id: string;
  /** One notice combines the browser stream with the server's recovery status. */
  stream?: { state: ConnState; message?: string | null };
}) {
  const [status, setStatus] = useState<{ state: string; message: string } | null>(null);
  useEffect(() => {
    let active = true;
    setStatus(null);
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
                "Waiting for Optio to respond. Running work may still be active; no commands are being replayed.",
            });
        });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [kind, id]);
  const notice =
    status && status.state !== "live" && status.state !== "ended"
      ? status
      : stream && stream.state !== "connected"
        ? {
            state: stream.state,
            message:
              stream.message ??
              (stream.state === "disconnected"
                ? "The terminal stream closed. Reload to reconnect; saved output is still available."
                : "Waiting for the terminal connection. Running work is preserved; no commands will be replayed."),
          }
        : null;
  if (!notice) return null;
  return (
    <div
      role="status"
      data-testid="session-connection-status"
      className="flex shrink-0 items-start gap-2 border-b border-warning/20 bg-warning/5 px-4 py-2.5 text-xs leading-relaxed text-text-muted"
    >
      {notice.state === "reconnecting" || notice.state === "connecting" ? (
        <RefreshCw className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-warning" />
      ) : (
        <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
      )}
      <p>
        <span className="mr-1 font-medium capitalize text-text">{notice.state}.</span>
        {notice.message}
      </p>
    </div>
  );
}
