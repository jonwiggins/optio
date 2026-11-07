"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useLocalFeedStore } from "@/components/local/local-feed";
import { useWorkSession } from "@/components/work-detail/session-context";
import { Sidebar } from "./sidebar";
import { PodSessionRail } from "@/components/pod-session-rail";
import { TerminalRail } from "@/components/local/terminal-rail";
import { ResizableSessionRail } from "@/components/local/resizable-session-rail";
import { useRailStore } from "@/components/local/rail-store";
import { LocalAttentionWatcher } from "@/components/local/attention-watcher";
import { GlobalWebSocketProvider } from "./ws-provider";
import { SetupCheck } from "./setup-check";
import { ThemeProvider } from "./theme-provider";
import { ThemedToaster } from "./themed-toaster";
import { OptioChatPanel } from "@/components/optio-chat";
import { PushSwRegistrar } from "@/components/notifications/push-sw-registrar";
import { GlobalAuthBanner } from "./global-auth-banner";
import { NoWorkspace } from "./no-workspace";
import { useCurrentUserStore } from "@/hooks/use-current-user";
import { useWorkspaceSync } from "@/hooks/use-workspace-sync";

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  // Another tab's workspace switch is this tab's too: every call sends it.
  useWorkspaceSync();
  const isSetup = pathname === "/setup";
  const isLogin = pathname === "/login" || pathname === "/shared-session";
  // Signed in, but in no workspace (only admins create them here): nothing
  // else in the app would load, so say what to do instead.
  const user = useCurrentUserStore((s) => s.user);
  const authDisabled = useCurrentUserStore((s) => s.authDisabled);
  const loaded = useCurrentUserStore((s) => s.loaded);
  useEffect(() => {
    if (!isLogin && !loaded) void useCurrentUserStore.getState().load();
  }, [isLogin, loaded]);
  // Only the API's explicit `workspaceId: null` means "no workspace": a user
  // object without the field (an older API, the auth-disabled identity) is
  // not that state.
  const noWorkspace = loaded && !authDisabled && !!user && user.workspaceId === null;
  // Inside a local terminal the sidebar becomes the session rail, so jumping
  // between many terminals never leaves the terminal view.
  const session = useWorkSession();
  const terminals = useLocalFeedStore((s) => s.terminals);
  const workId = /^\/work\/([0-9a-f-]{36})$/i.exec(pathname)?.[1];
  const knownLocal = terminals.some((t) => t.id === workId || t.taskId === workId);
  const inLocalTerminal =
    /^\/local\/[^/]+$/.test(pathname) ||
    !!(workId && (session.pathname === pathname ? session.local : knownLocal || session.local));
  // Keep the rail mounted while another work id resolves, but forget the
  // pending-session fallback when navigating out to the rest of the app.
  useEffect(() => {
    if (!workId)
      useWorkSession.setState({ pathname: null, terminalId: null, local: false, pod: false });
  }, [workId]);
  const inPodSession = !!(workId && !inLocalTerminal && session.pod);
  const inSession = inLocalTerminal || inPodSession;
  // The attention watcher (favicon dot, tab badge, notifications for local
  // terminals) runs wherever those terminals are listed or open: the
  // work list and the terminal view itself.
  const inLocal = inLocalTerminal || pathname === "/work";
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  // Wide screens only — collapsing hands the rail's width to the terminal.
  // The phone drawer ignores it. Persisted; hydrated after mount so SSR and
  // the first client render agree.
  useEffect(() => {
    useRailStore.getState().hydrate();
  }, []);
  useEffect(() => {
    if (!inSession) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !e.shiftKey || e.altKey) return;
      if (e.key.toLowerCase() !== "b") return;
      e.preventDefault();
      e.stopPropagation();
      useRailStore.getState().toggle();
    };
    // Capture phase so it wins over xterm's textarea, like the rail's shortcuts.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [inSession]);

  // iOS Safari: the on-screen keyboard shrinks the *visual* viewport but not
  // 100dvh, so a focused terminal's input line ends up under the keyboard.
  // Track the visual viewport into a CSS var the shell's height uses.
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => {
      document.documentElement.style.setProperty("--app-height", `${Math.round(vv.height)}px`);
    };
    apply();
    vv.addEventListener("resize", apply);
    return () => {
      vv.removeEventListener("resize", apply);
      document.documentElement.style.removeProperty("--app-height");
    };
  }, []);

  if (noWorkspace && user && !isLogin && !isSetup) {
    return (
      <ThemeProvider>
        <NoWorkspace user={user} />
        <ThemedToaster />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider>
      {!isLogin && <SetupCheck />}
      {!isLogin && <GlobalWebSocketProvider />}
      {!isLogin && !isSetup && <PushSwRegistrar />}
      {inLocal && <LocalAttentionWatcher />}
      {isSetup || isLogin ? (
        <main className="min-h-screen">{children}</main>
      ) : (
        <div className="flex flex-col h-dvh" style={{ height: "var(--app-height, 100dvh)" }}>
          <GlobalAuthBanner />
          <div className="flex flex-1 min-h-0">
            {/* Mobile overlay */}
            {sidebarOpen && (
              <div className="fixed inset-0 z-20 bg-black/50 md:hidden" onClick={closeSidebar} />
            )}
            {inSession ? (
              <ResizableSessionRail
                open={sidebarOpen}
                onClose={closeSidebar}
                sessionKind={inPodSession ? "pod" : "local"}
              >
                <Suspense fallback={null}>
                  {inPodSession ? (
                    <PodSessionRail onNavigate={closeSidebar} />
                  ) : (
                    <TerminalRail onNavigate={closeSidebar} />
                  )}
                </Suspense>
              </ResizableSessionRail>
            ) : (
              <Sidebar open={sidebarOpen} onClose={closeSidebar} />
            )}
            <OptioChatPanel />
            <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
              {/* Mobile header */}
              <div className="md:hidden shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-card pt-[max(0.75rem,env(safe-area-inset-top))]">
                <button
                  onClick={() => setSidebarOpen(true)}
                  className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted transition-colors"
                  aria-label="Open menu"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M4 6h16M4 12h16M4 18h16"
                    />
                  </svg>
                </button>
                <span className="font-semibold text-sm">Optio</span>
              </div>
              {/* Session panes own their scrolling. The page must stay fixed
                  while xterm fits its grid or a chat's content grows. */}
              <main
                className={cn(
                  "flex-1 min-w-0 min-h-0",
                  inSession ? "overflow-clip" : "overflow-auto",
                )}
              >
                {children}
              </main>
            </div>
          </div>
        </div>
      )}
      <ThemedToaster />
    </ThemeProvider>
  );
}
