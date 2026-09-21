"use client";

import { Suspense, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/** The list moved from /sessions to /work (v0.6); old bookmarks keep their view. */
export default function LegacySessionsRedirect() {
  return (
    <Suspense fallback={null}>
      <Redirect />
    </Suspense>
  );
}

function Redirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const qs = searchParams.toString();
    router.replace(qs ? `/work?${qs}` : "/work");
  }, [searchParams, router]);
  return null;
}
