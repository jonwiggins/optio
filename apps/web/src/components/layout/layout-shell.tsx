"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import { Sidebar } from "./sidebar";
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
  const isLogin = pathname === "/login";
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <ThemeProvider>
      {!isLogin && <SetupCheck />}
      {!isLogin && <GlobalWebSocketProvider />}
      {!isLogin && !isSetup && <PushSwRegistrar />}
      {isSetup || isLogin ? (
        <main className="min-h-screen">{children}</main>
      ) : (
        <div className="flex flex-col h-screen">
          <GlobalAuthBanner />
          <div className="flex flex-1 min-h-0">
            {/* Mobile overlay */}
            {sidebarOpen && (
              <div
                className="fixed inset-0 z-20 bg-black/50 md:hidden"
                onClick={() => setSidebarOpen(false)}
              />
            )}
            <Sidebar open={sidebarOpen} onClose={() => setSidebarOpen(false)} />
            <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
              {/* Mobile header */}
              <div className="md:hidden shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-bg-card">
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
              <main className="flex-1 overflow-auto">{children}</main>
            </div>
            <OptioChatPanel />
          </div>
        </div>
      )}
      <ThemedToaster />
    </ThemeProvider>
  );
}
