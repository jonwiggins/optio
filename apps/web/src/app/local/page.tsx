"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * The Local terminal list is retired: terminals on your machines are rows
 * in the one list at /work, and Local Automations are edited on
 * /machines. Individual terminals open at /work/:id.
 */
export default function LegacyLocalRedirect() {
  const router = useRouter();
  useEffect(() => {
    const wantsNew = new URLSearchParams(window.location.search).get("new") === "1";
    router.replace(wantsNew ? "/work/new" : "/work");
  }, [router]);
  return null;
}
