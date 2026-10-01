"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePageTitle } from "@/hooks/use-page-title";
import { api } from "@/lib/api-client";
import Link from "next/link";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Server,
  Circle,
  ChevronRight,
  Activity,
  Cpu,
  HardDrive,
  Network,
  AlertTriangle,
  RefreshCw,
  Container,
  Database,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { Panel, PanelEmpty } from "@/components/ui/panel";
import { Segmented } from "@/components/ui/segmented";
import { StatTile } from "@/components/ui/stat-tile";

const STATUS_COLORS: Record<string, string> = {
  Running: "text-success",
  Ready: "text-success",
  ready: "text-success",
  Succeeded: "text-text-muted",
  Pending: "text-warning",
  provisioning: "text-warning",
  ImagePullBackOff: "text-error",
  ErrImagePull: "text-error",
  CrashLoopBackOff: "text-error",
  Error: "text-error",
  error: "text-error",
  Failed: "text-error",
  failed: "text-error",
  NotReady: "text-error",
  Unknown: "text-text-muted",
};

export default function ClusterPage() {
  usePageTitle("Cluster");
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"pods" | "events" | "services">("pods");

  const refresh = () => {
    api
      .getClusterOverview()
      .then(setData)
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, 8000);
    return () => clearInterval(interval);
  }, []);

  const header = (
    <PageHeader
      icon={Server}
      title="Cluster"
      description="The Kubernetes side of Optio: nodes, pods, events, and services in the optio namespace."
      actions={
        <button
          onClick={refresh}
          className="p-2 rounded-lg hover:bg-bg-hover text-text-muted transition-all btn-press hover:text-text"
          title="Refresh"
          aria-label="Refresh"
        >
          <RefreshCw className="w-4 h-4" />
        </button>
      }
    />
  );

  if (loading) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        {header}
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[84px] skeleton-shimmer rounded-xl" />
            ))}
          </div>
          <div className="h-20 skeleton-shimmer rounded-xl" />
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-14 skeleton-shimmer rounded-lg" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 max-w-6xl mx-auto">
        {header}
        <EmptyState
          icon={AlertTriangle}
          title="Failed to load cluster data"
          description="The API couldn't reach the Kubernetes API. It retries every few seconds."
        />
      </div>
    );
  }

  const { nodes, pods, services, events, repoPods, summary } = data;

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {header}
      <div className="space-y-6">
        {/* Summary tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatTile
            icon={Server}
            label="Nodes"
            value={withSub(`${summary.readyNodes}/${summary.totalNodes}`, "ready")}
            tone={summary.readyNodes < summary.totalNodes ? "text-error" : undefined}
          />
          <StatTile
            icon={Container}
            label="Pods"
            value={withSub(`${summary.runningPods}/${summary.totalPods}`, "running")}
          />
          <StatTile
            icon={Activity}
            label="Agent pods"
            value={withSub(String(summary.agentPods), "optio-managed")}
          />
          <StatTile
            icon={Database}
            label="Infrastructure"
            value={withSub(String(summary.infraPods), "postgres + redis")}
          />
        </div>

        {/* Node info */}
        {nodes.length > 0 && (
          <Panel
            title="Nodes"
            actions={<span className="text-text-muted tabular-nums">{nodes.length}</span>}
          >
            <div className="divide-y divide-border/40">
              {nodes.map((node: any) => (
                <div
                  key={node.name}
                  className="flex items-center gap-x-4 gap-y-1 flex-wrap px-4 py-2.5 text-xs"
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Circle
                      className={cn(
                        "w-2 h-2 fill-current shrink-0",
                        node.status === "Ready" ? "text-success" : "text-error",
                      )}
                    />
                    <span className="font-mono font-medium text-sm truncate">{node.name}</span>
                  </span>
                  <span className="text-text-muted">{node.kubeletVersion}</span>
                  <span className="text-text-muted flex items-center gap-1">
                    <Cpu className="w-3 h-3" />
                    {node.cpuPercent != null ? (
                      <>
                        <span className="font-medium text-text">{node.cpuPercent}%</span> of{" "}
                        {node.cpu} cores
                      </>
                    ) : (
                      <>{node.cpu} cores</>
                    )}
                  </span>
                  <span className="text-text-muted flex items-center gap-1">
                    <HardDrive className="w-3 h-3" />
                    {node.memoryUsedGi != null ? (
                      <>
                        <span className="font-medium text-text">{node.memoryUsedGi}</span> /{" "}
                        {node.memoryTotalGi} Gi
                      </>
                    ) : (
                      formatK8sResource(node.memory)
                    )}
                  </span>
                  <span className="text-text-muted">{node.containerRuntime}</span>
                </div>
              ))}
            </div>
          </Panel>
        )}

        {/* Tabs */}
        <Segmented
          size="md"
          surface="card"
          aria-label="Cluster resources"
          value={tab}
          onChange={setTab}
          options={[
            {
              value: "pods",
              label: "Pods",
              icon: <Container className="w-3.5 h-3.5" />,
              count: pods.length,
            },
            {
              value: "events",
              label: "Events",
              icon: <AlertTriangle className="w-3.5 h-3.5" />,
              count: events.length,
            },
            {
              value: "services",
              label: "Services",
              icon: <Network className="w-3.5 h-3.5" />,
              count: services.length,
            },
          ]}
        />

        {/* Pods tab */}
        {tab === "pods" && (
          <Panel title="Pods">
            {pods.length === 0 ? (
              <PanelEmpty>No pods in the optio namespace.</PanelEmpty>
            ) : (
              <div className="divide-y divide-border/40">
                {pods.map((pod: any) => {
                  const color = STATUS_COLORS[pod.status] ?? "text-text-muted";
                  const repoPod = repoPods.find((rp: any) => rp.podName === pod.name);

                  return (
                    <div
                      key={pod.name}
                      className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-bg-hover/40 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <Circle className={cn("w-2.5 h-2.5 fill-current shrink-0", color)} />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="font-mono text-sm font-medium truncate">
                              {pod.name}
                            </span>
                            {pod.isOptioManaged && (
                              <span className="text-[10px] px-1.5 py-px rounded bg-primary/10 text-primary shrink-0">
                                workspace
                              </span>
                            )}
                            {pod.isInfra && (
                              <span className="text-[10px] px-1.5 py-px rounded bg-info/10 text-info shrink-0">
                                infra
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[11px] text-text-muted mt-0.5">
                            <span className={color}>{pod.status}</span>
                            {pod.cpuMillicores != null && <span>{pod.cpuMillicores}m CPU</span>}
                            {pod.memoryMi != null && <span>{pod.memoryMi} Mi RAM</span>}
                            {pod.restarts > 0 && (
                              <span className="text-warning">{pod.restarts} restarts</span>
                            )}
                            <span className="font-mono">{pod.image?.split("/").pop()}</span>
                            {pod.ip && <span>{pod.ip}</span>}
                            {pod.startedAt && <span>{formatRelativeTime(pod.startedAt)}</span>}
                          </div>
                        </div>
                      </div>
                      {repoPod && (
                        <Link
                          href={`/cluster/${repoPod.id}`}
                          className="text-xs text-primary hover:underline flex items-center gap-1 shrink-0"
                        >
                          Details <ChevronRight className="w-3 h-3" />
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>
        )}

        {/* Events tab */}
        {tab === "events" && (
          <Panel title="Events">
            {events.length === 0 ? (
              <PanelEmpty>No recent events.</PanelEmpty>
            ) : (
              <div className="divide-y divide-border/40">
                {events.map((event: any, i: number) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-xs">
                    <AlertTriangle
                      className={cn(
                        "w-3.5 h-3.5 shrink-0 mt-0.5",
                        event.type === "Warning" ? "text-warning" : "text-info",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{event.reason}</span>
                        <span className="text-text-muted font-mono">{event.involvedObject}</span>
                        {event.count > 1 && <span className="text-text-muted">x{event.count}</span>}
                      </div>
                      <p className="text-text-muted mt-0.5">{event.message}</p>
                    </div>
                    {event.lastTimestamp && (
                      <span className="text-text-muted/60 shrink-0">
                        {formatRelativeTime(event.lastTimestamp)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {/* Services tab */}
        {tab === "services" && (
          <Panel title="Services">
            {services.length === 0 ? (
              <PanelEmpty>No services in the optio namespace.</PanelEmpty>
            ) : (
              <div className="divide-y divide-border/40">
                {services.map((svc: any) => (
                  <div
                    key={svc.name}
                    className="flex items-center justify-between gap-3 flex-wrap px-4 py-2.5 text-xs"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Network className="w-4 h-4 text-text-muted shrink-0" />
                      <div className="min-w-0">
                        <span className="font-mono font-medium text-sm">{svc.name}</span>
                        <span className="text-text-muted ml-2">{svc.type}</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-text-muted font-mono">
                      <span>{svc.clusterIP}</span>
                      {svc.ports?.map((p: any, i: number) => (
                        <span key={i}>
                          {p.port}→{String(p.targetPort)}/{p.protocol}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>
    </div>
  );
}

/** A StatTile value with a quiet caption line under the number. */
function withSub(value: ReactNode, sub: ReactNode) {
  return (
    <>
      {value}
      <div className="text-xs font-normal text-text-muted mt-0.5 tracking-normal">{sub}</div>
    </>
  );
}

/** Format K8s resource quantities like "32813152Ki" into human-readable values */
function formatK8sResource(value: string | undefined): string {
  if (!value) return "—";
  // Handle Ki (kibibytes)
  const kiMatch = value.match(/^(\d+)Ki$/);
  if (kiMatch) {
    const ki = parseInt(kiMatch[1], 10);
    if (ki >= 1048576) return `${(ki / 1048576).toFixed(1)} Gi`;
    if (ki >= 1024) return `${(ki / 1024).toFixed(0)} Mi`;
    return `${ki} Ki`;
  }
  // Handle Mi
  const miMatch = value.match(/^(\d+)Mi$/);
  if (miMatch) {
    const mi = parseInt(miMatch[1], 10);
    if (mi >= 1024) return `${(mi / 1024).toFixed(1)} Gi`;
    return `${mi} Mi`;
  }
  // Handle Gi
  const giMatch = value.match(/^(\d+)Gi$/);
  if (giMatch) return `${giMatch[1]} Gi`;
  // Handle plain bytes
  const bytes = parseInt(value, 10);
  if (!isNaN(bytes)) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} Gi`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} Mi`;
    return value;
  }
  return value;
}
