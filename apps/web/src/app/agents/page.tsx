"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The per-kind Agents list is retired: every kind of work lives in the one
 * list at /sessions. Redirect so existing bookmarks still land somewhere.
 */
export default function LegacyRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/work?view=agents");
  }, [router]);
  return null;
}
