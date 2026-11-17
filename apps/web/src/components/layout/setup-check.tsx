"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export function SetupCheck() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    // Don't redirect if already on setup page
    if (pathname === "/setup") return;

    api
      .getSetupStatus()
      .then((res) => {
        if (!res.isSetUp) {
          router.replace("/setup");
        }
      })
      .catch(() => {
        // API not reachable — don't redirect, let user see the dashboard
      });
  }, [pathname, router]);

  return null;
}
