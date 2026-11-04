"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Eye, Link2, Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";

/** The old page's "review any PR by URL", kept below the list. */
export function ReviewAnyPr() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const submit = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const res = await api.createPrReview({ prUrl: url.trim() });
      toast.success("Review started");
      router.push(`/reviews/${res.review.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start review");
      setBusy(false);
    }
  };
  return (
    <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:items-center">
      <label htmlFor="review-any-pr" className="text-xs text-text-muted shrink-0">
        Review any other PR with Optio
      </label>
      <div className="relative flex-1 min-w-0 sm:max-w-md">
        <Link2 className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
        <input
          id="review-any-pr"
          ref={input}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="https://github.com/owner/repo/pull/123"
          className={inputClass({ size: "sm", className: "pl-8 bg-bg-card" })}
        />
      </div>
      <Button size="sm" variant="secondary" onClick={submit} disabled={busy || !url.trim()}>
        {busy ? <Loader2 className="animate-spin" /> : <Eye />}
        Review
      </Button>
    </div>
  );
}
