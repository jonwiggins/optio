"use client";

import { useEffect, useState } from "react";
import { User } from "lucide-react";
import { api } from "@/lib/api-client";

// One members fetch per page load, shared by every badge.
let membersPromise: Promise<Map<string, string>> | null = null;

function memberNames(): Promise<Map<string, string>> {
  if (!membersPromise) {
    membersPromise = api
      .getCurrentUser()
      .then(async ({ user }) => {
        const names = new Map<string, string>([[user.id, "you"]]);
        if (!user.workspaceId) return names;
        const { members } = await api.listWorkspaceMembers(user.workspaceId);
        for (const m of members) {
          if (!names.has(m.userId)) names.set(m.userId, m.displayName || m.email);
        }
        return names;
      })
      .catch(() => {
        membersPromise = null;
        return new Map<string, string>();
      });
  }
  return membersPromise;
}

/** "Runs as <name>" for personal work (`ownerUserId` set); nothing for the organization's. */
export function RunsAsBadge({ ownerUserId }: { ownerUserId?: string | null }) {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (!ownerUserId) return;
    let live = true;
    memberNames().then((names) => {
      if (live) setName(names.get(ownerUserId) ?? null);
    });
    return () => {
      live = false;
    };
  }, [ownerUserId]);
  if (!ownerUserId) return null;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-primary/10 text-primary"
      title="Runs with this person's secrets, providers and connections; only they can change it."
    >
      <User className="w-3 h-3" />
      Runs as {name ?? "its owner"}
    </span>
  );
}
