"use client";

import { use, useEffect, useState } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { cn, formatRelativeTime } from "@/lib/utils";
import { StateBadge } from "@/components/state-badge";
import { toast } from "sonner";
import {
  Loader2,
  ArrowLeft,
  Server,
  Circle,
  GitBranch,
  Clock,
  Activity,
  ExternalLink,
  RotateCcw,
  Play,
  History,
} from "lucide-react";
import { DetailHeader } from "@/components/detail-header";
import { MetadataCard } from "@/components/metadata-card";
import { Panel, PanelEmpty } from "@/components/ui/panel";

export default function PodDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const [pod, setPod] = useState<any>(null);
  usePageTitle(pod?.podName ?? "Pod");
  const [loading, setLoading] = useState(true);
  const [healthEvents, setHealthEvents] = useState<any[]>([]);
  const [restarting, setRestarting] = useState(false);

  useEffect(() => {
    api
      .getClusterPod(id)
      .then((res) => {
        setPod(res.pod);
        api
          .getHealthEvents(20)
          .then((evRes) => {
            setHealthEvents(evRes.events.filter((e: any) => e.repoPodId === id));
          })
          .catch(() => {});
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);

  const handleRestart = async () => {
    if (!confirm("Restart this pod? Active tasks will be failed.")) return;
    setRestarting(true);
    try {
      await api.restartPod(id);
      toast.success("Pod restart initiated");
      router.push("/cluster");
    } catch {
      toast.error("Failed to restart pod");
    }
    setRestarting(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
      </div>
    );
  }

  if (!pod) {
    return <div className="flex items-center justify-center h-full text-error">Pod not found</div>;
  }

  const runtimeState = pod.runtimeStatus?.state ?? pod.state;
  const repoName =
    pod.repoUrl?.replace(/.*github\.com[/:]/, "").replace(/\.git$/, "") ?? pod.repoUrl;

  const runtimeBadge =
    runtimeState === "running"
      ? "running"
      : runtimeState === "failed" || runtimeState === "error"
        ? "failed"
        : runtimeState;

  return (
    <>
      <DetailHeader
        title={pod.podName ?? "Pod"}
        subtitle={
          <Link href="/cluster" className="inline-flex items-center gap-1 hover:text-primary">
            <ArrowLeft className="w-3 h-3" />
            Cluster
          </Link>
        }
        state={runtimeBadge}
        metaItems={[
          <>
            <Server className="w-3 h-3" />
            Repo pod
          </>,
          <span key="repo" className="inline-flex items-center gap-1 font-mono">
            <GitBranch className="w-3 h-3" />
            {repoName}
          </span>,
        ]}
        actions={
          <button
            onClick={handleRestart}
            disabled={restarting}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-error/10 text-error text-xs hover:bg-error/20 disabled:opacity-50 transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            {restarting ? "Restarting..." : "Restart Pod"}
          </button>
        }
      />

      <div className="p-6 max-w-5xl mx-auto space-y-6">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetadataCard
            icon={Circle}
            label="State"
            value={<span className="capitalize">{runtimeState}</span>}
          />
          <MetadataCard icon={GitBranch} label="Repo" value={repoName} />
          <MetadataCard icon={Activity} label="Active tasks" value={pod.activeTaskCount} />
          <MetadataCard icon={Clock} label="Created" value={formatRelativeTime(pod.createdAt)} />
          {pod.runtimeStatus?.startedAt && (
            <MetadataCard
              icon={Play}
              label="Started"
              value={new Date(pod.runtimeStatus.startedAt).toLocaleString()}
            />
          )}
          {pod.runtimeStatus?.startedAt && pod.lastTaskAt && (
            <MetadataCard
              icon={History}
              label="Last task"
              value={formatRelativeTime(pod.lastTaskAt)}
            />
          )}
        </div>

        {pod.errorMessage && (
          <div className="p-3 rounded-lg border border-error/20 bg-error/5 text-error text-sm">
            {pod.errorMessage}
          </div>
        )}

        <Panel
          title="Tasks"
          actions={<span className="text-text-muted tabular-nums">{pod.tasks?.length ?? 0}</span>}
        >
          {pod.tasks?.length > 0 ? (
            <div className="divide-y divide-border/60">
              {pod.tasks.map((task: any) => (
                <Link
                  key={task.id}
                  href={`/tasks/${task.id}`}
                  className="flex items-center justify-between gap-4 px-4 py-3 bg-bg-card/40 hover:bg-bg-hover/60 transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StateBadge state={task.state} />
                    <span className="text-sm font-medium text-text-heading truncate">
                      {task.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 text-[11px] text-text-muted shrink-0">
                    <span className="capitalize">{task.agentType?.replace("-", " ")}</span>
                    <span className="text-text-muted/70">{formatRelativeTime(task.createdAt)}</span>
                    <ExternalLink className="w-3 h-3" />
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <PanelEmpty>No tasks have run on this pod yet.</PanelEmpty>
          )}
        </Panel>

        {healthEvents.length > 0 && (
          <Panel title="Health events">
            <div className="divide-y divide-border/60">
              {healthEvents.map((event: any) => (
                <div key={event.id} className="px-4 py-2.5 bg-bg-card/40 text-xs">
                  <div className="flex items-center gap-2">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        event.eventType === "healthy" || event.eventType === "orphan_cleaned"
                          ? "bg-success"
                          : event.eventType === "restarted"
                            ? "bg-warning"
                            : "bg-error",
                      )}
                    />
                    <span className="font-medium capitalize">
                      {event.eventType.replace("_", " ")}
                    </span>
                    <span className="text-text-muted ml-auto">
                      {formatRelativeTime(event.createdAt)}
                    </span>
                  </div>
                  {event.message && <p className="text-text-muted mt-1 ml-4">{event.message}</p>}
                </div>
              ))}
            </div>
          </Panel>
        )}
      </div>
    </>
  );
}
