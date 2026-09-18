"use client";

import { Suspense, use, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { usePageTitle } from "@/hooks/use-page-title";
import { Loader2 } from "lucide-react";
import { TerminalPane } from "@/components/local/terminal-pane";
import { parseSplit, splitHref, type SplitLayout } from "@/components/local/split-state";

/**
 * Focus view. The route id is the primary pane; `?split=a,b` opens up to two
 * more terminals beside (or, with `&layout=rows`, below) it. Phones always
 * stack. See docs/optio-local.md.
 */
export default function LocalTerminalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-full text-text-muted">
          <Loader2 className="w-5 h-5 animate-spin mr-2" />
          Loading terminal...
        </div>
      }
    >
      <Panes primary={id} />
    </Suspense>
  );
}

function Panes({ primary }: { primary: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { split, layout } = useMemo(
    () => parseSplit(searchParams, primary),
    [searchParams, primary],
  );
  const paneIds = useMemo(() => [primary, ...split], [primary, split]);

  const [hosts, setHosts] = useState<any[]>([]);
  useEffect(() => {
    api
      .listLocalHosts()
      .then((res) => setHosts(res.hosts))
      .catch(() => {});
  }, []);

  const [title, setTitle] = useState<string | null>(null);
  usePageTitle(title ?? "Local");
  const onPrimaryTitle = useCallback((t: string) => setTitle(t), []);

  const setLayout = (next: SplitLayout) => router.replace(splitHref(primary, split, next));
  const closePane = (id: string) =>
    router.replace(
      splitHref(
        primary,
        split.filter((x) => x !== id),
        layout,
      ),
    );
  const focusPane = (id: string) =>
    router.push(splitHref(id, [primary, ...split.filter((x) => x !== id)], layout));

  return (
    <div
      className={cn(
        "h-full flex min-w-0 min-h-0",
        // Phones stack regardless; wider screens honor the layout choice.
        layout === "cols" ? "flex-col md:flex-row" : "flex-col",
      )}
    >
      {paneIds.map((id, i) => (
        <div
          key={id}
          className={cn(
            "flex-1 min-w-0 min-h-0 basis-0",
            i > 0 &&
              (layout === "cols"
                ? "border-t md:border-t-0 md:border-l border-border"
                : "border-t border-border"),
          )}
        >
          <TerminalPane
            terminalId={id}
            variant={i === 0 ? "primary" : "split"}
            hosts={hosts}
            onDeleted={() => router.push("/local")}
            onTitle={i === 0 ? onPrimaryTitle : undefined}
            chrome={{
              paneCount: paneIds.length,
              layout,
              onLayout: setLayout,
              onClose: i > 0 ? () => closePane(id) : undefined,
              onFocus: i > 0 ? () => focusPane(id) : undefined,
            }}
          />
        </div>
      ))}
    </div>
  );
}
