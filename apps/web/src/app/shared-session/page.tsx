"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api-client";

export default function SharedSessionPage() {
  const router = useRouter();
  const started = useRef(false);
  const [message, setMessage] = useState("Opening shared session…");
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const key = "optio_pending_session_share";
    const token = window.location.hash.slice(1) || sessionStorage.getItem(key);
    // The bearer link stays out of URLs sent to servers, referrers and logs.
    if (window.location.hash) {
      sessionStorage.setItem(key, token ?? "");
      history.replaceState(null, "", "/shared-session");
    }
    if (!token) {
      setMessage("Open the full collaboration link shared with you.");
      return;
    }
    api
      .redeemSessionShare(token)
      .then((result) => {
        sessionStorage.removeItem(key);
        router.replace(`/${result.kind === "pod" ? "sessions" : "local"}/${result.targetId}`);
      })
      .catch((err) => {
        if (err.status === 401) router.replace("/login?redirect=/shared-session");
        else setMessage(err.message ?? "This link is unavailable.");
      });
  }, [router]);
  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <p className="max-w-md text-center text-sm text-text-muted" role="status">
        {message}
      </p>
    </main>
  );
}
