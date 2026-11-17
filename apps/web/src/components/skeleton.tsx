import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer", className)} />;
}

function TaskCardSkeleton() {
  return (
    <div className="p-5 rounded-xl border border-border/50 bg-bg-card space-y-3">
      <div className="flex items-start justify-between">
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-3 w-1/4" />
    </div>
  );
}

function StatCardSkeleton() {
  return (
    <div className="p-4 rounded-xl border border-border/50 bg-bg-card space-y-2.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-10" />
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="page-column py-6 space-y-6">
      <Skeleton className="h-7 w-40" />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </div>
      <div className="space-y-2">
        <TaskCardSkeleton />
        <TaskCardSkeleton />
        <TaskCardSkeleton />
      </div>
    </div>
  );
}

/**
 * A Work row's shape while the list loads: name and chips, the five
 * attribute pills, a status chip and a time on the right — so the page
 * takes its final layout at once instead of showing a few flat bars.
 */
function WorkRowSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3 px-4 py-4 sm:px-5 bg-bg-card/40">
      <div className="min-w-0 flex-1 basis-48">
        <div className="flex items-center gap-2">
          <Skeleton className={cn("h-4", wide ? "w-2/3 max-w-sm" : "w-1/2 max-w-xs")} />
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-12" />
        </div>
      </div>
      <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:shrink-0 sm:flex-col sm:items-end">
        <Skeleton className="h-6 w-20 rounded-md" />
        <Skeleton className="h-3 w-14" />
      </div>
    </div>
  );
}

export function WorkListSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label="Loading work"
      className="rounded-xl border border-border/70 overflow-hidden divide-y divide-border/60"
    >
      {Array.from({ length: rows }, (_, i) => (
        <WorkRowSkeleton key={i} wide={i % 3 === 1} />
      ))}
    </div>
  );
}

/**
 * A session page's shape while its work resolves: the header a terminal
 * pane renders (icon, title, status, controls; machine and directory
 * beneath) over the dark screen area, with a few lines of output.
 */
export function SessionSkeleton({ label = "Loading work" }: { label?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-label={label}
      className="flex h-full min-h-0 flex-col"
      data-testid="session-skeleton"
    >
      <div className="shrink-0 border-b border-border/70 bg-bg-card/40 px-3 py-2 sm:px-4">
        <div className="flex items-center gap-2">
          <Skeleton className="h-6 w-6 rounded-md" />
          <Skeleton className="h-4 w-48 max-w-[40%]" />
          <Skeleton className="h-3 w-16" />
          <div className="ml-auto flex items-center gap-1.5">
            <Skeleton className="h-8 w-20 rounded-lg" />
            <Skeleton className="h-8 w-8 rounded-lg" />
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-40 max-w-[50%]" />
        </div>
      </div>
      <div className="flex-1 min-h-0 bg-[#09090b] px-4 py-3 space-y-2.5">
        <Skeleton className="h-3 w-1/3 opacity-30" />
        <Skeleton className="h-3 w-2/3 opacity-30" />
        <Skeleton className="h-3 w-1/2 opacity-30" />
        <Skeleton className="h-3 w-1/4 opacity-30" />
      </div>
    </div>
  );
}
