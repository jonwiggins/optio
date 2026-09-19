"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The standalone-only create page is retired in favor of the unified form
 * at /sessions/new (one form for every kind of session). Redirect here so
 * existing bookmarks still work.
 */
export default function LegacyNewJobRedirect() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/sessions/new");
  }, [router]);
  return null;
}
