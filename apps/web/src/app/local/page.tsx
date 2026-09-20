"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The Local terminal list is retired: terminals on your machines are rows
 * in the one list at /sessions, and Local Automations are edited on
 * /machines. Individual terminals still open at /local/:id.
 */
export default function LegacyLocalRedirect() {
  const router = useRouter();
  useEffect(() => {
    const wantsNew = new URLSearchParams(window.location.search).get("new") === "1";
    router.replace(wantsNew ? "/sessions/new" : "/sessions");
  }, [router]);
  return null;
}
