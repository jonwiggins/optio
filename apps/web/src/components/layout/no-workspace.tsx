"use client";

import { LogOut, Users } from "lucide-react";
import { api } from "@/lib/api-client";
import type { CurrentUser } from "@/hooks/use-current-user";

/**
 * Shown instead of the app to someone who is signed in but belongs to no
 * workspace: the deployment lets only its admins create workspaces
 * (`workspaces.creation`), and nobody has added them yet. Every workspace
 * route answers 403 for them until a workspace admin does.
 */
export function NoWorkspace({ user }: { user: CurrentUser }) {
  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // best-effort
    }
    window.location.href = "/login";
  };
  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-xl border border-border bg-bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Users className="w-5 h-5 text-text-muted" aria-hidden />
          <h1 className="text-base font-semibold">You aren&apos;t in a workspace yet</h1>
        </div>
        <p className="text-sm text-text-muted">
          You&apos;re signed in as{" "}
          <span className="text-text">{user.email || user.displayName}</span>, but this Optio lets
          only its administrators create workspaces. Ask a workspace admin to add you, then reload
          this page.
        </p>
        <button
          type="button"
          onClick={signOut}
          className="inline-flex items-center gap-2 text-sm text-text-muted hover:text-text"
        >
          <LogOut className="w-4 h-4" aria-hidden />
          Sign out
        </button>
      </div>
    </main>
  );
}
