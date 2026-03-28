export interface TaskStats {
  total: number;
  queued: number;
  running: number;
  ci: number;
  review: number;
  needsAttention: number;
  failed: number;
  completed: number;
}

export interface UsageData {
  available: boolean;
  fiveHour?: { utilization: number | null; resetsAt: string | null };
  sevenDay?: { utilization: number | null; resetsAt: string | null };
  sevenDaySonnet?: { utilization: number | null; resetsAt: string | null };
  sevenDayOpus?: { utilization: number | null; resetsAt: string | null };
  extraUsage?: {
    isEnabled: boolean;
    monthlyLimit: number | null;
    usedCredits: number | null;
    utilization: number | null;
  };
}

export interface MetricsHistoryPoint {
  time: number;
  cpuPercent: number | null;
  memoryPercent: number | null;
  pods: number;
  agents: number;
}

export const STATUS_COLORS: Record<string, string> = {
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

export function formatK8sResource(value: string | undefined): string {
  if (!value) return "\u2014";
  const kiMatch = value.match(/^(\d+)Ki$/);
  if (kiMatch) {
    const ki = parseInt(kiMatch[1], 10);
    if (ki >= 1048576) return `${(ki / 1048576).toFixed(1)} Gi`;
    if (ki >= 1024) return `${(ki / 1024).toFixed(0)} Mi`;
    return `${ki} Ki`;
  }
  const miMatch = value.match(/^(\d+)Mi$/);
  if (miMatch) {
    const mi = parseInt(miMatch[1], 10);
    if (mi >= 1024) return `${(mi / 1024).toFixed(1)} Gi`;
    return `${mi} Mi`;
  }
  const giMatch = value.match(/^(\d+)Gi$/);
  if (giMatch) return `${giMatch[1]} Gi`;
  const bytes = parseInt(value, 10);
  if (!isNaN(bytes)) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(1)} Gi`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(0)} Mi`;
  }
  return value;
}
