import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton-shimmer", className)} />;
}

export function TaskCardSkeleton() {
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

export function StatCardSkeleton() {
  return (
    <div className="p-4 rounded-xl border border-border/50 bg-bg-card space-y-2.5">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-10" />
    </div>
  );
}

export function PageSkeleton() {
  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
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
