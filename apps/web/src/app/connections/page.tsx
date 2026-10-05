"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Plug, Plus, Search } from "lucide-react";
import { toast } from "sonner";
import type { WorkEnvironmentEntry } from "@optio/shared";
import { usePageTitle } from "@/hooks/use-page-title";
import { useCurrentUser } from "@/hooks/use-current-user";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { countByOwner, privateHint } from "@/lib/owner";
import { entrySubtext, kindLabel } from "@/lib/connections";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { OwnerSegments, useOwnerFilter } from "@/components/ui/owner-segments";
import { ScopedList } from "@/components/ui/scoped-list";
import { ConnectGallery, type ConnectCreated } from "@/components/connections/connect-gallery";
import { ConnectionEditor } from "@/components/connections/connection-editor";
import { ConnectionRow } from "@/components/connections/connections-list";

/**
 * Library → Connections: one list of everything work can be connected to —
 * provider connections ("Acme AWS"), bare secrets ("STRIPE_KEY"), hand-written
 * MCP servers ("docs-mcp") — sectioned by owner, filtered by kind (`?kind=`)
 * and by a search box. **Connect** opens the gallery; each row carries Test
 * and a ⋯ menu.
 */
export default function ConnectionsPage() {
  usePageTitle("Connections");
  // `useOwnerFilter` / `useKindFilter` read the URL, which Next needs inside Suspense.
  return (
    <Suspense fallback={<div className="page-column py-6 h-16 skeleton-shimmer rounded-lg" />}>
      <ConnectionsBody />
    </Suspense>
  );
}

// ── Kind filter (`?kind=`) ──────────────────────────────────────────────────

type KindFilter = "all" | "service" | "secret" | "mcp";
const KIND_FILTERS: readonly KindFilter[] = ["all", "service", "secret", "mcp"];
const KIND_OF_ENTRY: Record<WorkEnvironmentEntry["kind"], KindFilter> = {
  connection: "service",
  secret: "secret",
  mcpServer: "mcp",
};

function parseKindFilter(raw: string | null | undefined): KindFilter {
  return raw && (KIND_FILTERS as readonly string[]).includes(raw) ? (raw as KindFilter) : "all";
}

/** The `?kind=` filter of the page, kept in the URL like `useOwnerFilter` keeps `?owner=`. */
function useKindFilter(): [KindFilter, (v: KindFilter) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [value, setValue] = useState<KindFilter>(() => parseKindFilter(params.get("kind")));
  const set = useCallback(
    (v: KindFilter) => {
      setValue(v);
      const next = new URLSearchParams(params.toString());
      if (v === "all") next.delete("kind");
      else next.set("kind", v);
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [params, pathname, router],
  );
  return [value, set];
}

/** Rows whose name, provider, or subtext contains the query (case-insensitive). */
function matchesQuery(
  entry: WorkEnvironmentEntry,
  viewerId: string | null,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [entry.name, kindLabel(entry), entry.providerSlug ?? "", entrySubtext(entry, viewerId)]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

// ── Page ────────────────────────────────────────────────────────────────────

function ConnectionsBody() {
  const { userId, isAdmin } = useCurrentUser();
  const [owner, setOwner] = useOwnerFilter();
  const [kind, setKind] = useKindFilter();
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<WorkEnvironmentEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(() => {
    return api
      .listConnectionCatalog()
      .then((res) => setEntries(res.entries))
      .catch((err) => {
        toast.error("Couldn't load connections", {
          description: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The gallery already said "Connected …"; just show the new row.
  const onCreated = (_entry: ConnectCreated) => {
    void load();
  };

  const counts = countByOwner(entries, userId);
  const byKind = useMemo(() => {
    const c: Record<KindFilter, number> = { all: entries.length, service: 0, secret: 0, mcp: 0 };
    for (const e of entries) c[KIND_OF_ENTRY[e.kind]]++;
    return c;
  }, [entries]);

  const filtered = useMemo(
    () =>
      entries.filter(
        (e) => (kind === "all" || KIND_OF_ENTRY[e.kind] === kind) && matchesQuery(e, userId, query),
      ),
    [entries, kind, query, userId],
  );

  const connectButton = (
    <Button onClick={() => setGalleryOpen(true)}>
      <Plus />
      Connect
    </Button>
  );

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={Plug}
        title="Connections"
        description="Everything your agents can be connected to: services, secrets, and MCP servers."
        meta={
          entries.length > 0 ? (
            <span>
              {entries.length} connection{entries.length === 1 ? "" : "s"} · {counts.organization}{" "}
              organization · {counts.private} private
              {counts.others > 0 && ` · ${counts.others} other people's`}
            </span>
          ) : null
        }
        actions={connectButton}
      />

      {entries.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <OwnerSegments rows={entries} viewerId={userId} value={owner} onChange={setOwner} />
          <div data-testid="connections-kind-filter">
            <Segmented
              size="md"
              surface="card"
              wrap
              className="gap-1"
              aria-label="Filter by kind"
              value={kind}
              onChange={setKind}
              options={[
                { value: "all", label: "All", count: byKind.all },
                { value: "service", label: "Services", count: byKind.service },
                { value: "secret", label: "Secrets", count: byKind.secret },
                { value: "mcp", label: "MCP servers", count: byKind.mcp },
              ]}
            />
          </div>
          <div className="relative flex-1 min-w-[12rem] max-w-xs ml-auto">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search connections"
              aria-label="Search connections"
              className={cn(inputClass({ size: "sm" }), "pl-8")}
            />
          </div>
        </div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border/70 px-6 py-12 text-center">
          <Plug className="w-6 h-6 mx-auto text-text-muted mb-3" />
          <h2 className="text-sm font-medium text-text-heading mb-1">Nothing connected yet</h2>
          <p className="text-sm text-text-muted max-w-md mx-auto mb-4">
            Connect the services your agents use — AWS, Linear, Pylon, PagerDuty, a secret, an MCP
            server.
          </p>
          {connectButton}
        </div>
      ) : (
        <ScopedList
          rows={filtered}
          filter={owner}
          viewerId={userId}
          privateEmpty={privateHint("connections")}
          sectionActions={(scope) =>
            scope === "others" ? null : (
              <button
                type="button"
                onClick={() => setGalleryOpen(true)}
                className="text-primary hover:underline"
              >
                + Connect
              </button>
            )
          }
          render={(rows) =>
            rows.length === 0 ? (
              <p className="px-4 py-4 text-xs text-text-muted">
                {query || kind !== "all" ? "Nothing matches." : "No connections in this scope."}
              </p>
            ) : (
              rows.map((entry) => (
                <ConnectionRow
                  key={`${entry.kind}:${entry.ownerUserId ?? ""}:${entry.id}`}
                  entry={entry}
                  viewerId={userId}
                  isAdmin={isAdmin}
                  onChanged={() => void load()}
                  onEditConnection={setEditingId}
                />
              ))
            )
          }
        />
      )}

      <ConnectGallery
        open={galleryOpen}
        onClose={() => setGalleryOpen(false)}
        onCreated={onCreated}
        defaultOwner={
          owner === "private" ? "private" : owner === "organization" ? "organization" : undefined
        }
      />

      {editingId && (
        <ConnectionEditor
          connectionId={editingId}
          open
          onClose={() => setEditingId(null)}
          onSaved={() => void load()}
          onDeleted={() => void load()}
        />
      )}
    </div>
  );
}
