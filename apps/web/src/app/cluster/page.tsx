"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api-client";
import Link from "next/link";
import { cn, formatRelativeTime } from "@/lib/utils";
import {
  Loader2,
  Server,
  Circle,
  GitBranch,
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
import { StateBadge } from "@/components/state-badge";

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full text-text-muted">
        <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading cluster...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="flex items-center justify-center h-full text-error">
        Failed to load cluster data
      </div>
    );
  }

  const { nodes, pods, services, events, repoPods, summary } = data;

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Cluster</h1>
        <button onClick={refresh} className="p-1.5 rounded-md hover:bg-bg-hover text-text-muted">
          <RefreshCw className="w-4 h-4" />
        </button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          icon={Server}
          label="Nodes"
          value={`${summary.readyNodes}/${summary.totalNodes}`}
          sub="ready"
          color="text-success"
        />
        <SummaryCard
          icon={Container}
          label="Pods"
          value={`${summary.runningPods}/${summary.totalPods}`}
          sub="running"
          color="text-primary"
        />
        <SummaryCard
          icon={Activity}
          label="Agent Pods"
          value={String(summary.agentPods)}
          sub="optio-managed"
          color="text-warning"
        />
        <SummaryCard
          icon={Database}
          label="Infrastructure"
          value={String(summary.infraPods)}
          sub="postgres + redis"
          color="text-info"
        />
      </div>

      {/* Node info */}
      {nodes.length > 0 && (
        <div className="p-3 rounded-lg border border-border bg-bg-card">
          <h3 className="text-xs font-medium text-text-muted mb-2">Nodes</h3>
          {nodes.map((node: any) => (
            <div key={node.name} className="flex items-center gap-4 text-xs">
              <Circle
                className={cn(
                  "w-2 h-2 fill-current",
                  node.status === "Ready" ? "text-success" : "text-error",
                )}
              />
              <span className="font-mono font-medium">{node.name}</span>
              <span className="text-text-muted">{node.kubeletVersion}</span>
              <span className="text-text-muted flex items-center gap-1">
                <Cpu className="w-3 h-3" />
                {node.cpuPercent != null ? (
                  <>
                    <span className="font-medium text-text">{node.cpuPercent}%</span> of {node.cpu}{" "}
                    cores
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
      )}

      {/* Tabs */}
      <div className="flex gap-0 border-b border-border">
        {(["pods", "events", "services"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              "px-4 py-2 text-sm border-b-2 transition-colors capitalize",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-text-muted hover:text-text",
            )}
          >
            {t} {t === "pods" && `(${pods.length})`}
            {t === "events" && `(${events.length})`}
            {t === "services" && `(${services.length})`}
          </button>
        ))}
      </div>

      {/* Pods tab */}
      {tab === "pods" && (
        <div className="space-y-1.5">
          {pods.map((pod: any) => {
            const color = STATUS_COLORS[pod.status] ?? "text-text-muted";
            const repoPod = repoPods.find((rp: any) => rp.podName === pod.name);

            return (
              <div
                key={pod.name}
                className="flex items-center justify-between p-3 rounded-md border border-border bg-bg-card"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Circle className={cn("w-2.5 h-2.5 fill-current shrink-0", color)} />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-medium">{pod.name}</span>
                      {pod.isOptioManaged && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-primary/10 text-primary">
                          workspace
                        </span>
                      )}
                      {pod.isInfra && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-info/10 text-info">
                          infra
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-text-muted mt-0.5">
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
                    className="text-xs text-primary hover:underline flex items-center gap-1"
                  >
                    Details <ChevronRight className="w-3 h-3" />
                  </Link>
                )}
              </div>
            );
          })}
          {pods.length === 0 && (
            <div className="text-center py-8 text-text-muted text-sm">
              No pods in the optio namespace
            </div>
          )}
        </div>
      )}

      {/* Events tab */}
      {tab === "events" && (
        <div className="space-y-1">
          {events.map((event: any, i: number) => (
            <div
              key={i}
              className="flex items-start gap-3 p-2.5 rounded-md border border-border bg-bg-card text-xs"
            >
              <AlertTriangle
                className={cn(
                  "w-3.5 h-3.5 shrink-0 mt-0.5",
                  event.type === "Warning" ? "text-warning" : "text-info",
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{event.reason}</span>
                  <span className="text-text-muted font-mono">{event.involvedObject}</span>
                  {event.count > 1 && <span className="text-text-muted">x{event.count}</span>}
                </div>
                <p className="text-text-muted mt-0.5">{event.message}</p>
                {event.lastTimestamp && (
                  <span className="text-text-muted/50">
                    {formatRelativeTime(event.lastTimestamp)}
                  </span>
                )}
              </div>
            </div>
          ))}
          {events.length === 0 && (
            <div className="text-center py-8 text-text-muted text-sm">No recent events</div>
          )}
        </div>
      )}

      {/* Services tab */}
      {tab === "services" && (
        <div className="space-y-1.5">
          {services.map((svc: any) => (
            <div
              key={svc.name}
              className="flex items-center justify-between p-3 rounded-md border border-border bg-bg-card text-xs"
            >
              <div className="flex items-center gap-3">
                <Network className="w-4 h-4 text-text-muted" />
                <div>
                  <span className="font-mono font-medium text-sm">{svc.name}</span>
                  <span className="text-text-muted ml-2">{svc.type}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 text-text-muted">
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
    </div>
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

function SummaryCard({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: any;
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="p-3 rounded-lg border border-border bg-bg-card">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={cn("w-4 h-4", color)} />
        <span className="text-xs text-text-muted">{label}</span>
      </div>
      <div className="text-xl font-bold">{value}</div>
      <div className="text-[10px] text-text-muted">{sub}</div>
    </div>
  );
}
