"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

/** Editing moved from /sessions/:id/edit to /work/:id/edit (v0.6). */
export default function LegacyEditRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  useEffect(() => {
    router.replace(`/work/${id}/edit`);
  }, [id, router]);
  return null;
}
