"use client";

import { rememberSessionLayout } from "@/hooks/use-session-layout";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Terminal, X } from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { parsePodTerminals, podTerminalsHref } from "./pod-terminal-panes";
import { SessionRailScroll } from "./local/session-rail-scroll";
import { WorkLinkBadges, workLinksSearchText } from "./local/work-links";
import { SessionRailHeader } from "./local/session-rail-header";

export function PodSessionRail({ onNavigate }: { onNavigate?: () => void }) {
  const id = usePathname().split("/")[2];
  const router = useRouter();
  const replaceLayout = (href: string) => router.replace(rememberSessionLayout(href));
  const panes = parsePodTerminals(useSearchParams());
  const [sessions, setSessions] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const { sessions: rows } = await api.listSessions({ limit: 100 });
        // A collaborator's active session is intentionally absent from their own list.
        if (!rows.some((s) => s.id === id)) {
          const { session } = await api.getSession(id);
          rows.unshift(session);
        }
        if (!disposed) setSessions(rows);
      } catch {
        /* Keep the last successful list during a reconnect. */
      }
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id]);
  const shown = sessions.filter((s) =>
    `${s.title ?? ""} ${s.repoUrl} ${s.branch} ${workLinksSearchText(s.links ?? [])}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );
  const focus = (pane: string) => {
    const el = document.querySelector<HTMLElement>(`[data-session-pane="pod-${pane}"]`);
    el?.scrollIntoView({ block: "nearest" });
    el?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    onNavigate?.();
  };
  return (
    <div className="flex h-full min-h-0 flex-col">
      <SessionRailHeader
        count={sessions.filter((s) => s.state === "active").length}
        search={search}
        onSearch={setSearch}
        onNavigate={onNavigate}
      />
      <SessionRailScroll className="px-1.5 py-2">
        {(["active", "ended"] as const).map((state) => {
          const rows = shown.filter((s) => s.state === state);
          return (
            rows.length > 0 && (
              <div key={state} className="mb-3">
                <div className="px-2 py-2 text-[11px] font-medium text-text-muted">
                  {state === "active" ? "Live" : "Finished"}{" "}
                  <span className="ml-1 font-normal opacity-60">{rows.length}</span>
                </div>
                {rows.map((s) => (
                  <div
                    key={s.id}
                    data-session-group={s.id === id && panes.length ? s.id : undefined}
                  >
                    <Link
                      href={`/work/${s.id}`}
                      onClick={(e) => {
                        if (s.id === id) {
                          e.preventDefault();
                          focus("main");
                        } else onNavigate?.();
                      }}
                      aria-current={s.id === id ? "page" : undefined}
                      className={cn(
                        "block rounded-xl border border-transparent px-2.5 py-2.5 transition-colors",
                        s.id === id
                          ? "sidebar-link-active text-text-heading"
                          : "text-text-muted hover:bg-bg-hover/60 hover:text-text",
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span
                          className={cn(
                            "h-1.5 w-1.5 shrink-0 rounded-full",
                            state === "active" ? "bg-primary" : "bg-text-muted/30",
                          )}
                        />
                        <span className="truncate text-[13px] font-medium">
                          {s.title || s.branch}
                        </span>
                      </div>
                      <div className="mt-0.5 truncate pl-3.5 font-mono text-[10px] text-text-muted/80">
                        {s.repoUrl
                          ? s.repoUrl.split("/").slice(-2).join("/")
                          : (s.agentRuntime ?? "Pod")}
                      </div>
                    </Link>
                    <WorkLinkBadges
                      links={s.links ?? []}
                      size="xs"
                      max={2}
                      className="ml-3.5 mb-1"
                    />
                    {s.id === id && panes.length > 0 && (
                      <div
                        aria-label="Grouped terminals"
                        title="Pane groups belong to this view"
                        className="ml-4 mr-1 mt-0.5 mb-1 border-l border-primary/20 pl-2"
                      >
                        {panes.map((pane) => (
                          <div
                            key={pane}
                            className="group flex items-center rounded-md hover:bg-bg-hover/60"
                          >
                            <button
                              type="button"
                              onClick={() => focus(pane)}
                              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-xs text-text-muted hover:text-text"
                            >
                              <Terminal className="h-3.5 w-3.5 shrink-0 text-primary/80" />
                              Terminal {Number(pane) + 1}
                            </button>
                            <button
                              type="button"
                              aria-label={`Ungroup terminal ${Number(pane) + 1}`}
                              title="Close pane; keep the shell running"
                              onClick={() =>
                                replaceLayout(
                                  podTerminalsHref(
                                    id,
                                    panes.filter((p) => p !== pane),
                                  ),
                                )
                              }
                              className="rounded p-1 text-text-muted/60 hover:text-text md:opacity-0 md:group-hover:opacity-100 focus:opacity-100"
                            >
                              <X className="h-3 w-3" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )
          );
        })}
        {shown.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-text-muted">
            {search ? "Nothing matches." : "No sessions yet."}
          </p>
        )}
      </SessionRailScroll>
    </div>
  );
}
