"use client";

import { useEffect, useRef, useState } from "react";
import { Share2, Copy, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";

export function SessionShareButton({
  kind,
  id,
  ownerId,
}: {
  kind: "pod" | "local";
  id: string;
  ownerId?: string | null;
}) {
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [mine, setMine] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [url, setUrl] = useState("");
  const [shares, setShares] = useState<
    Array<{ id: string; expiresAt: string; revokedAt: string | null }>
  >([]);
  useEffect(() => {
    api
      .getCurrentUser()
      .then(({ user, authDisabled }) => setMine(!authDisabled && user.id === ownerId))
      .catch(() => {});
  }, [ownerId]);
  useEffect(() => {
    if (open)
      api
        .listSessionShares(kind, id)
        .then((r) => setShares(r.shares))
        .catch(() => {});
  }, [open, kind, id]);
  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
      }
      if (event.key !== "Tab") return;
      const items = [
        ...(dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, [tabindex="0"]',
        ) ?? []),
      ];
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    dialog.current?.querySelector<HTMLElement>("button")?.focus();
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      trigger.current?.focus();
    };
  }, [open]);
  if (!mine) return null;
  const create = async () => {
    setBusy(true);
    try {
      const share = await api.createSessionShare(kind, id);
      setUrl(new URL(share.path, window.location.origin).href);
      setShares((prev) => [...prev, { ...share, revokedAt: null }]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not share session");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        ref={trigger}
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-text-muted hover:bg-bg-hover hover:text-text"
        aria-label="Share session"
      >
        <Share2 className="h-3.5 w-3.5" />
        Share
      </button>
      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setOpen(false)}
        >
          <section
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby="share-session-title"
            className="w-full max-w-md space-y-4 rounded-2xl border border-border bg-bg-card p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
            }}
          >
            <div className="flex items-center justify-between">
              <h2 id="share-session-title" className="font-semibold">
                Collaborate on this session
              </h2>
              <button onClick={() => setOpen(false)} aria-label="Close sharing">
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-sm text-text-muted">
              Members of your organization can use this link to view and control the session. They
              can access its files and credentials
              {kind === "local" ? " and run commands on your machine" : ""}.
            </p>
            <p className="text-xs text-text-muted">
              Links expire after 24 hours. Revoking a link disconnects collaborators.
            </p>
            {url ? (
              <div className="flex gap-2">
                <input
                  readOnly
                  value={url}
                  aria-label="Session sharing link"
                  className="min-w-0 flex-1 rounded-lg border border-border bg-bg p-2 text-xs"
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button
                  className="rounded-lg bg-primary px-3 text-white"
                  aria-label="Copy sharing link"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(url)
                      .then(() => toast.success("Link copied"))
                      .catch(() => toast.error("Select and copy the link"));
                  }}
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <button
                disabled={busy}
                onClick={create}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {busy ? "Creating…" : "Create collaboration link"}
              </button>
            )}
            {shares
              .filter((s) => !s.revokedAt && new Date(s.expiresAt).getTime() > Date.now())
              .map((share) => (
                <div
                  key={share.id}
                  className="flex items-center justify-between gap-2 border-t border-border pt-3 text-xs"
                >
                  <span className="text-text-muted">
                    Expires {new Date(share.expiresAt).toLocaleString()}
                  </span>
                  <button
                    className="text-error"
                    onClick={async () => {
                      try {
                        await api.revokeSessionShare(kind, id, share.id);
                        setShares((prev) => prev.filter((s) => s.id !== share.id));
                        setUrl("");
                      } catch {
                        toast.error("Could not revoke link");
                      }
                    }}
                  >
                    Revoke
                  </button>
                </div>
              ))}
          </section>
        </div>
      )}
    </>
  );
}
