"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import { classifyError } from "@optio/shared";
import { AlertTriangle, RefreshCw, Zap } from "lucide-react";
import Link from "next/link";

type FailureData = Awaited<ReturnType<typeof api.getFailureAnalytics>>;

export function FailureInsights() {
  const [data, setData] = useState<FailureData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getFailureAnalytics({ days: 7 })
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5">
        <div className="h-4 w-32 skeleton-shimmer mb-4" />
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-10 skeleton-shimmer" />
          ))}
        </div>
      </div>
    );
  }

  if (!data || data.errorMessages.length === 0) return null;

  // Group by error category using the classifier
  const categoryMap = new Map<string, { title: string; count: number }>();
  for (const err of data.errorMessages) {
    const classified = classifyError(err.message);
    const existing = categoryMap.get(classified.category);
    if (existing) {
      existing.count += err.count;
    } else {
      categoryMap.set(classified.category, {
        title: classified.title,
        count: err.count,
      });
    }
  }
  const topCategories = [...categoryMap.values()].sort((a, b) => b.count - a.count).slice(0, 3);

  return (
    <div className="bg-gradient-to-br from-bg-card to-bg-card/80 border border-border/50 rounded-xl p-5 card-hover">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-text-muted">
          Top Failures (7d)
        </h3>
        <AlertTriangle className="w-4 h-4 text-text-muted/50" />
      </div>
      <div className="space-y-2.5">
        {topCategories.map((cat, i) => (
          <div
            key={i}
            className="flex items-center gap-3 p-2.5 rounded-lg bg-bg-hover/40 border border-border/30"
          >
            <div className="w-7 h-7 rounded-md bg-error/10 flex items-center justify-center shrink-0">
              <AlertTriangle className="w-3.5 h-3.5 text-error" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text truncate">{cat.title}</p>
            </div>
            <span className="text-sm font-semibold tabular-nums text-text-muted">{cat.count}</span>
          </div>
        ))}
      </div>
      {data.retriedCount > 0 && (
        <div className="mt-3 flex items-center gap-4 text-xs text-text-muted">
          <span className="flex items-center gap-1">
            <RefreshCw className="w-3 h-3" />
            Retry success: {data.retrySuccessRate}%
          </span>
          {data.stallCount > 0 && (
            <span className="flex items-center gap-1">
              <Zap className="w-3 h-3" />
              Stalls: {data.stallCount} ({data.stallRecoveryRate}% recovered)
            </span>
          )}
        </div>
      )}
      <Link
        href="/analytics"
        className="mt-3 block text-xs text-primary hover:text-primary-hover transition-colors"
      >
        View all failure insights →
      </Link>
    </div>
  );
}
