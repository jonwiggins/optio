"use client";

import { useCurrentUser } from "@/hooks/use-current-user";
import { OwnerChip } from "@/components/ui/owner-chip";

/**
 * The owner chip in a detail page's header: **Private** for your own work,
 * **Private · Name** for someone else's (what an admin sees, read-only);
 * nothing for the organization's. The chip's title says the rule — private
 * work runs with its owner's secrets, providers and connections, and only
 * they can change or run it.
 */
export function RunsAsBadge({
  ownerUserId,
  ownerName,
}: {
  ownerUserId?: string | null;
  ownerName?: string | null;
}) {
  const { userId } = useCurrentUser();
  if (!ownerUserId) return null;
  return <OwnerChip size="sm" row={{ ownerUserId, ownerName }} viewerId={userId} />;
}
