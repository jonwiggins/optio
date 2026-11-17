"use client";
import { useEffect, useState } from "react";
import type { WorkOrigin } from "@optio/shared";
import { api } from "@/lib/api-client";
import { AgentAvatar } from "./agent-avatar";

export function ResolvedWorkAvatar({
  id,
  runtime,
  fallback,
}: {
  id: string;
  runtime?: string | null;
  fallback?: WorkOrigin | null;
}) {
  const [resolved, setResolved] = useState<{
    id: string;
    origin?: WorkOrigin | null;
    runtime: string;
  } | null>(null);
  useEffect(() => {
    let disposed = false;
    api
      .getWork(id)
      .then(({ row }) => {
        if (!disposed && row) setResolved({ id, origin: row.origin, runtime: row.who });
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [id]);
  return (
    <AgentAvatar
      runtime={runtime ?? (resolved?.id === id ? resolved.runtime : undefined)}
      origin={resolved?.id === id ? (resolved.origin ?? fallback) : fallback}
    />
  );
}
