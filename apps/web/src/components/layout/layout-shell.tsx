"use client";

import { Suspense, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
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

export function LayoutShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isSetup = pathname === "/setup";
  const isLogin = pathname === "/login" || pathname === "/shared-session";
  // Inside a local terminal the sidebar becomes the session rail, so jumping
  // between many terminals never leaves the terminal view.
  const inLocalTerminal = /^\/local\/[^/]+$/.test(pathname);
  const inPodSession = /^\/sessions\/[^/]+$/.test(pathname) && pathname !== "/sessions/new";
  const inSession = inLocalTerminal || inPodSession;
  // The attention watcher (favicon dot, tab badge, notifications for local
  // terminals) runs wherever those terminals are listed or open: the
  // work list and the terminal view itself.
  const inLocal = pathname.startsWith("/local/") || pathname === "/work";
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
              <div
                className="fixed inset-0 z-20 bg-black/50 md:hidden"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            {inSession ? (
              <ResizableSessionRail open={sidebarOpen}>
                <Suspense fallback={null}>
                  {inPodSession ? (
                    <PodSessionRail onNavigate={() => setSidebarOpen(false)} />
                  ) : (
                    <TerminalRail onNavigate={() => setSidebarOpen(false)} />
                  )}
                </Suspense>
              </ResizableSessionRail>
            ) : (
              <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            )}
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
            <OptioChatPanel />
          </div>
        </div>
      )}
      <ThemedToaster />
    </ThemeProvider>
  );
}
