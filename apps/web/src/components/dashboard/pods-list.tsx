"use client";

import { useState } from "react";
import Link from "next/link";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Activity,
  Circle,
  Cpu,
  HardDrive,
  Container,
  ChevronDown,
  AlertTriangle,
  X,
  Clock,
} from "lucide-react";
import { StateBadge } from "@/components/state-badge";
import { EmptyState } from "./empty-state.js";
import { STATUS_COLORS } from "./types.js";

function CapacityIndicator({ repoPod }: { repoPod: any }) {
  const active = repoPod.activeTaskCount ?? 0;
  const max = repoPod.maxAgentsPerPod ?? repoPod.maxConcurrentTasks ?? 2;
  const pct = max > 0 ? Math.min((active / max) * 100, 100) : 0;
  const color = pct >= 100 ? "bg-error" : pct >= 50 ? "bg-warning" : "bg-success";

  return (
    <span className="flex items-center gap-1.5 text-[9px] text-text-muted tabular-nums">
      <span className="h-1.5 w-10 rounded-full bg-border/50 overflow-hidden inline-block">
        <span
          className={cn("h-full rounded-full block transition-all", color)}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span>
        {active}/{max}
      </span>
    </span>
  );
}

export function PodsList({
  pods,
  events,
  recentTasks,
  repoPodRecords,
}: {
  pods: any[];
  events: any[];
  recentTasks: any[];
  repoPodRecords: any[];
}) {
  const [expandedPods, setExpandedPods] = useState<Set<string>>(new Set());
  const [dismissedEvents, setDismissedEvents] = useState<Set<number>>(new Set());

  const repoPodByName = new Map<string, any>(
    (repoPodRecords ?? []).map((rp: any) => [rp.podName, rp]),
  );

  return (
    <div className="min-w-0 overflow-hidden">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-medium text-text-heading">Pods</h2>
      </div>
      {pods.length === 0 ? (
        <EmptyState
          icon={Container}
          title="No pods running"
          description="Pods are created automatically when tasks start. They stay warm for fast iteration."
        />
      ) : (
        <div className="space-y-1.5">
          {pods.map((pod: any) => {
            const color = STATUS_COLORS[pod.status] ?? "text-text-muted";
            const isExpanded = expandedPods.has(pod.name);
            const podTasks = pod.isOptioManaged
              ? recentTasks.filter((t: any) => t.containerId === pod.name)
              : [];
            const repoPod = pod.isOptioManaged ? repoPodByName.get(pod.name) : null;

            return (
              <div key={pod.name} className="rounded-md border border-border bg-bg-card">
                <button
                  onClick={() => {
                    if (!pod.isOptioManaged) return;
                    setExpandedPods((prev) => {
                      const next = new Set(prev);
                      if (next.has(pod.name)) next.delete(pod.name);
                      else next.add(pod.name);
                      return next;
                    });
                  }}
                  className={cn(
                    "w-full text-left p-2.5",
                    pod.isOptioManaged && "cursor-pointer hover:bg-bg-hover",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <Circle className={cn("w-2 h-2 fill-current shrink-0", color)} />
                    <span className="font-mono text-xs font-medium truncate">{pod.name}</span>
                    {pod.isOptioManaged && (
                      <>
                        <span className="text-[11px] px-1 py-0.5 rounded bg-primary/10 text-primary">
                          workspace
                        </span>
                        {repoPod && <CapacityIndicator repoPod={repoPod} />}
                        <ChevronDown
                          className={cn(
                            "w-3 h-3 text-text-muted ml-auto shrink-0 transition-transform",
                            isExpanded && "rotate-180",
                          )}
                        />
                      </>
                    )}
                    {pod.isInfra && (
                      <span className="text-[11px] px-1 py-0.5 rounded bg-info/10 text-info">
                        infra
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-text-muted mt-1 ml-4">
                    <span className={color}>{pod.status}</span>
                    {repoPod && (
                      <>
                        <span className="flex items-center gap-0.5">
                          <Activity className="w-3 h-3" />
                          {repoPod.activeTaskCount ?? 0} running
                        </span>
                        {(repoPod.queuedTaskCount ?? 0) > 0 && (
                          <span className="flex items-center gap-0.5 text-warning">
                            <Clock className="w-3 h-3" />
                            {repoPod.queuedTaskCount} queued
                          </span>
                        )}
                      </>
                    )}
                    {pod.cpuMillicores != null && (
                      <span className="flex items-center gap-0.5">
                        <Cpu className="w-3 h-3" />
                        {pod.cpuMillicores}m
                      </span>
                    )}
                    {pod.memoryMi != null && (
                      <span className="flex items-center gap-0.5">
                        <HardDrive className="w-3 h-3" />
                        {pod.memoryMi} Mi
                      </span>
                    )}
                    {pod.restarts > 0 && (
                      <span className="text-warning">{pod.restarts} restarts</span>
                    )}
                    <span className="font-mono">{pod.image?.split("/").pop()}</span>
                    {pod.startedAt && <span>{formatRelativeTime(pod.startedAt)}</span>}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border px-2.5 py-2 space-y-1">
                    {podTasks.length > 0 ? (
                      podTasks.map((t: any) => (
                        <Link
                          key={t.id}
                          href={`/tasks/${t.id}`}
                          className="flex items-center justify-between p-1.5 rounded hover:bg-bg-hover text-xs"
                        >
                          <span className="truncate">{t.title}</span>
                          <StateBadge state={t.state} />
                        </Link>
                      ))
                    ) : (
                      <div className="text-[10px] text-text-muted py-1">No recent tasks</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {events.filter((_: any, i: number) => !dismissedEvents.has(i)).length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-medium text-text-muted">Recent Events</h3>
            {dismissedEvents.size < events.length && (
              <button
                onClick={() => setDismissedEvents(new Set(events.map((_: any, i: number) => i)))}
                className="text-[10px] text-text-muted hover:text-text"
              >
                Dismiss all
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            {events.slice(0, 8).map((event: any, i: number) => {
              if (dismissedEvents.has(i)) return null;
              return (
                <div key={i} className="p-2.5 rounded-md border border-border bg-bg-card group">
                  <div className="flex items-center gap-2">
                    <AlertTriangle
                      className={cn(
                        "w-3 h-3 shrink-0",
                        event.type === "Warning" ? "text-warning" : "text-info",
                      )}
                    />
                    <span className="text-xs font-medium">{event.reason}</span>
                    <span className="text-xs text-text-muted font-mono">
                      {event.involvedObject}
                    </span>
                    {event.count > 1 && (
                      <span className="text-xs text-text-muted">x{event.count}</span>
                    )}
                    <span className="flex-1" />
                    {event.lastTimestamp && (
                      <span className="text-xs text-text-muted/50">
                        {formatRelativeTime(event.lastTimestamp)}
                      </span>
                    )}
                    <button
                      onClick={() => setDismissedEvents((prev) => new Set([...prev, i]))}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-hover text-text-muted transition-opacity"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                  <p className="text-xs text-text-muted mt-1 ml-5 truncate">{event.message}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
