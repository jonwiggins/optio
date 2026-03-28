"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  Activity,
  Circle,
  Cpu,
  HardDrive,
  Container,
  Database,
  ChevronDown,
  ChevronUp,
  DollarSign,
  BarChart3,
} from "lucide-react";
import { formatK8sResource } from "./types.js";
import type { MetricsHistoryPoint } from "./types.js";

function MiniChart({
  label,
  data,
  suffix,
  color,
  max: fixedMax,
}: {
  label: string;
  data: number[];
  suffix: string;
  color: string;
  max?: number;
}) {
  if (data.length < 2) return null;
  const current = data[data.length - 1];
  const max = fixedMax ?? Math.max(...data, 1);
  const min = fixedMax != null ? 0 : Math.min(...data);
  const range = max - min || 1;

  const w = 240;
  const h = 48;
  const points = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - ((v - min) / range) * h,
  }));

  const buildSmoothPath = (pts: { x: number; y: number }[]) => {
    if (pts.length < 2) return "";
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[Math.min(i + 2, pts.length - 1)];
      const cp1x = p1.x + (p2.x - p0.x) / 6;
      const cp1y = p1.y + (p2.y - p0.y) / 6;
      const cp2x = p2.x - (p3.x - p1.x) / 6;
      const cp2y = p2.y - (p3.y - p1.y) / 6;
      d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
    }
    return d;
  };
  const linePath = buildSmoothPath(points);
  const areaPath = `${linePath} L ${w} ${h} L 0 ${h} Z`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[11px] font-medium text-text-muted">{label}</span>
        <span className="text-[11px] font-medium tabular-nums">
          {current}
          {suffix}
        </span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-12" preserveAspectRatio="none">
        <defs>
          <linearGradient id={`grad-${label}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#grad-${label})`} />
        <path d={linePath} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" />
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="4"
          fill={color}
          opacity="0.2"
        />
        <circle
          cx={points[points.length - 1].x}
          cy={points[points.length - 1].y}
          r="2.5"
          fill={color}
        />
      </svg>
    </div>
  );
}

export function ClusterSummary({
  cluster,
  totalCost,
  metricsAvailable,
  metricsHistory,
}: {
  cluster: any;
  totalCost: number;
  metricsAvailable: boolean | null;
  metricsHistory: MetricsHistoryPoint[];
}) {
  const [showMetrics, setShowMetrics] = useState(false);

  const { nodes, summary } = cluster ?? {
    nodes: [],
    summary: {
      totalPods: 0,
      runningPods: 0,
      agentPods: 0,
      infraPods: 0,
      totalNodes: 0,
      readyNodes: 0,
    },
  };

  return (
    <div className="rounded-xl border border-border/50 bg-bg-card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 p-4">
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {nodes[0] && (
            <span className="flex items-center gap-1.5 text-text-muted font-mono border-r border-border pr-4 mr-1">
              {nodes[0].name} <span className="text-text-muted/50">/ optio</span>
            </span>
          )}
          <span className="flex items-center gap-1.5">
            <Circle
              className={cn(
                "w-2 h-2 fill-current",
                summary.readyNodes > 0 ? "text-success" : "text-error",
              )}
            />
            <span className="text-text-muted">Nodes</span>
            <span className="font-medium">
              {summary.readyNodes}/{summary.totalNodes}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Container className="w-3 h-3 text-text-muted" />
            <span className="text-text-muted">Pods</span>
            <span className="font-medium">
              {summary.runningPods}/{summary.totalPods}
            </span>
          </span>
          <span className="flex items-center gap-1.5">
            <Activity className="w-3 h-3 text-text-muted" />
            <span className="text-text-muted">Agents</span>
            <span className="font-medium">{summary.agentPods}</span>
          </span>
          <span className="flex items-center gap-1.5">
            <Database className="w-3 h-3 text-text-muted" />
            <span className="text-text-muted">Infra</span>
            <span className="font-medium">{summary.infraPods}</span>
          </span>
        </div>
        {nodes[0] && (
          <div className="flex items-center gap-3 text-[11px] text-text-muted">
            <span className="flex items-center gap-1">
              <Cpu className="w-3 h-3" />
              {nodes[0].cpuPercent != null ? (
                <>
                  <span className="font-medium text-text">{nodes[0].cpuPercent}%</span> of{" "}
                  {nodes[0].cpu} cores
                </>
              ) : (
                <>
                  <span className="font-medium text-text-muted/50">N/A</span> · {nodes[0].cpu} cores
                </>
              )}
            </span>
            <span className="flex items-center gap-1">
              <HardDrive className="w-3 h-3" />
              {nodes[0].memoryUsedGi != null ? (
                <>
                  <span className="font-medium text-text">{nodes[0].memoryUsedGi}</span> /{" "}
                  {nodes[0].memoryTotalGi} Gi
                </>
              ) : (
                <>
                  <span className="font-medium text-text-muted/50">N/A</span> ·{" "}
                  {formatK8sResource(nodes[0].memory)}
                </>
              )}
            </span>
            {totalCost > 0 && (
              <span className="flex items-center gap-1 border-l border-border pl-3 ml-1">
                <DollarSign className="w-3 h-3" />
                <span className="font-medium text-text">${totalCost.toFixed(2)}</span>
                <span className="text-text-muted">total</span>
              </span>
            )}
            <button
              onClick={() => setShowMetrics(!showMetrics)}
              className="flex items-center gap-1 ml-2 pl-3 border-l border-border text-text-muted hover:text-text transition-colors"
            >
              <BarChart3 className="w-3 h-3" />
              {showMetrics ? (
                <ChevronUp className="w-3 h-3" />
              ) : (
                <ChevronDown className="w-3 h-3" />
              )}
            </button>
          </div>
        )}
      </div>

      {showMetrics && (
        <div className="border-t border-border/30 px-4 py-4">
          {metricsAvailable === false ? (
            <div className="text-xs text-text-muted/50 text-center py-3">
              metrics-server not detected — CPU and memory charts unavailable.
              <br />
              <span className="text-[10px]">
                Install with: kubectl apply -f
                https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
              </span>
            </div>
          ) : metricsHistory.length > 1 ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                <MiniChart
                  label="CPU"
                  data={metricsHistory.map((m) => m.cpuPercent ?? 0)}
                  suffix="%"
                  color="var(--color-primary)"
                  max={100}
                />
                <MiniChart
                  label="Memory"
                  data={metricsHistory.map((m) => m.memoryPercent ?? 0)}
                  suffix="%"
                  color="var(--color-info)"
                  max={100}
                />
                <MiniChart
                  label="Pods"
                  data={metricsHistory.map((m) => m.pods)}
                  suffix=""
                  color="var(--color-success)"
                />
              </div>
              <div className="text-[10px] text-text-muted/40 mt-2 text-right">
                {metricsHistory.length} samples · refreshing every 10s
              </div>
            </>
          ) : (
            <div className="text-xs text-text-muted/50 text-center py-3">
              Collecting metrics data... graphs will appear in a few seconds.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
