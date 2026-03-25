import type { FastifyInstance } from "fastify";
import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";
import { db } from "../db/client.js";
import { repoPods, tasks, podHealthEvents, repos } from "../db/schema.js";
import { eq, desc, and, inArray, sql } from "drizzle-orm";

function getK8sConfig() {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc;
}

function getK8sApi() {
  return getK8sConfig().makeApiClient(CoreV1Api);
}

const NAMESPACE = "optio";

/** Fetch metrics from the K8s Metrics API (non-blocking) */
async function fetchMetrics<T>(path: string): Promise<T | null> {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync("kubectl", ["get", "--raw", path], {
      encoding: "utf-8",
      timeout: 3000,
    });
    return JSON.parse(stdout) as T;
  } catch {
    return null;
  }
}

interface MetricsUsage {
  cpu: string;
  memory: string;
}
interface NodeMetrics {
  metadata: { name: string };
  usage: MetricsUsage;
}
interface PodMetrics {
  metadata: { name: string };
  containers: Array<{ name: string; usage: MetricsUsage }>;
}

function parseCpuNano(cpu: string): number {
  // "183270758n" -> nanocores, "100m" -> millicores, "1" -> cores
  if (cpu.endsWith("n")) return parseInt(cpu, 10);
  if (cpu.endsWith("m")) return parseInt(cpu, 10) * 1_000_000;
  return parseInt(cpu, 10) * 1_000_000_000;
}

function parseMemoryKi(mem: string): number {
  // "1414112Ki" -> Ki
  if (mem.endsWith("Ki")) return parseInt(mem, 10);
  if (mem.endsWith("Mi")) return parseInt(mem, 10) * 1024;
  if (mem.endsWith("Gi")) return parseInt(mem, 10) * 1048576;
  return parseInt(mem, 10) / 1024; // assume bytes
}

function formatCpuPercent(usageNano: number, capacityCores: number): number {
  return Math.round((usageNano / (capacityCores * 1_000_000_000)) * 100);
}

function formatMemoryGi(ki: number): string {
  return (ki / 1048576).toFixed(1);
}

export async function clusterRoutes(app: FastifyInstance) {
  // Cluster overview: nodes, all pods, services, resource summary
  app.get("/api/cluster/overview", async (req, reply) => {
    try {
      const api = getK8sApi();

      const [nodeList, podList, serviceList, eventList] = await Promise.all([
        api.listNode({ limit: 50 }),
        api.listNamespacedPod({ namespace: NAMESPACE }),
        api.listNamespacedService({ namespace: NAMESPACE }),
        api.listNamespacedEvent({ namespace: NAMESPACE, limit: 30 }),
      ]);

      // Fetch metrics (gracefully fail if metrics-server not installed)
      const [nodeMetricsList, podMetricsList] = await Promise.all([
        fetchMetrics<{ items: NodeMetrics[] }>("/apis/metrics.k8s.io/v1beta1/nodes"),
        fetchMetrics<{ items: PodMetrics[] }>(
          `/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods`,
        ),
      ]);

      const nodeMetricsMap = new Map(
        (nodeMetricsList?.items ?? []).map((m) => [m.metadata.name, m.usage]),
      );
      const podMetricsMap = new Map(
        (podMetricsList?.items ?? []).map((m) => [
          m.metadata.name,
          m.containers.reduce(
            (acc, c) => ({
              cpu: acc.cpu + parseCpuNano(c.usage.cpu),
              memoryKi: acc.memoryKi + parseMemoryKi(c.usage.memory),
            }),
            { cpu: 0, memoryKi: 0 },
          ),
        ]),
      );

      const nodes = (nodeList.items ?? []).map((n) => {
        const name = n.metadata?.name ?? "";
        const capacityCpu = parseInt(n.status?.capacity?.["cpu"] ?? "0", 10);
        const capacityMemKi = parseMemoryKi(n.status?.capacity?.["memory"] ?? "0");
        const usage = nodeMetricsMap.get(name);
        const usageCpuNano = usage ? parseCpuNano(usage.cpu) : null;
        const usageMemKi = usage ? parseMemoryKi(usage.memory) : null;

        return {
          name,
          status:
            n.status?.conditions?.find((c) => c.type === "Ready")?.status === "True"
              ? "Ready"
              : "NotReady",
          kubeletVersion: n.status?.nodeInfo?.kubeletVersion,
          os: n.status?.nodeInfo?.osImage,
          arch: n.status?.nodeInfo?.architecture,
          cpu: n.status?.capacity?.["cpu"],
          memory: n.status?.capacity?.["memory"],
          containerRuntime: n.status?.nodeInfo?.containerRuntimeVersion,
          // Resource usage
          cpuPercent: usageCpuNano !== null ? formatCpuPercent(usageCpuNano, capacityCpu) : null,
          memoryUsedGi: usageMemKi !== null ? formatMemoryGi(usageMemKi) : null,
          memoryTotalGi: formatMemoryGi(capacityMemKi),
        };
      });

      const pods = (podList.items ?? []).map((p) => {
        const containerStatus = p.status?.containerStatuses?.[0];
        const waiting = containerStatus?.state?.waiting;
        const running = containerStatus?.state?.running;
        const terminated = containerStatus?.state?.terminated;
        const podName = p.metadata?.name ?? "";
        const metrics = podMetricsMap.get(podName);

        return {
          name: podName,
          phase: p.status?.phase,
          status:
            waiting?.reason ??
            (running ? "Running" : (terminated?.reason ?? p.status?.phase ?? "Unknown")),
          ready: containerStatus?.ready ?? false,
          restarts: containerStatus?.restartCount ?? 0,
          image: containerStatus?.image ?? p.spec?.containers?.[0]?.image,
          nodeName: p.spec?.nodeName,
          ip: p.status?.podIP,
          startedAt: running?.startedAt ?? p.status?.startTime,
          labels: p.metadata?.labels ?? {},
          isOptioManaged: p.metadata?.labels?.["managed-by"] === "optio",
          isInfra: !!(
            p.metadata?.labels?.["app"] && ["postgres", "redis"].includes(p.metadata.labels["app"])
          ),
          // Resource usage
          cpuMillicores: metrics ? Math.round(metrics.cpu / 1_000_000) : null,
          memoryMi: metrics ? Math.round(metrics.memoryKi / 1024) : null,
        };
      });

      const services = (serviceList.items ?? []).map((s) => ({
        name: s.metadata?.name,
        type: s.spec?.type,
        clusterIP: s.spec?.clusterIP,
        ports: s.spec?.ports?.map((p) => ({
          port: p.port,
          targetPort: p.targetPort,
          protocol: p.protocol,
        })),
      }));

      const events = (eventList.items ?? [])
        .sort((a, b) => {
          const aTime = a.lastTimestamp ?? a.metadata?.creationTimestamp ?? "";
          const bTime = b.lastTimestamp ?? b.metadata?.creationTimestamp ?? "";
          return String(bTime).localeCompare(String(aTime));
        })
        .slice(0, 20)
        .map((e) => ({
          type: e.type,
          reason: e.reason,
          message: e.message,
          involvedObject: e.involvedObject?.name,
          count: e.count,
          lastTimestamp: e.lastTimestamp ?? e.metadata?.creationTimestamp,
        }));

      // Get Optio-specific data (scoped to workspace if available)
      const workspaceId = req.user?.workspaceId;
      const repoPodRecords = workspaceId
        ? await db.select().from(repoPods).where(eq(repoPods.workspaceId, workspaceId))
        : await db.select().from(repoPods);

      // Get per-repo task indicators: queued counts and maxConcurrentTasks
      const repoUrls = repoPodRecords.map((rp) => rp.repoUrl);

      // Queued task counts per repo
      const queuedCounts =
        repoUrls.length > 0
          ? await db
              .select({
                repoUrl: tasks.repoUrl,
                count: sql<number>`count(*)::int`,
              })
              .from(tasks)
              .where(
                and(inArray(tasks.repoUrl, repoUrls), inArray(tasks.state, ["queued", "pending"])),
              )
              .groupBy(tasks.repoUrl)
          : [];

      const queuedMap = new Map(queuedCounts.map((r) => [r.repoUrl, r.count]));

      // Live running/provisioning task count per pod (derived from actual task states)
      const runningCounts = await db
        .select({
          podId: tasks.lastPodId,
          count: sql<number>`count(*)::int`,
        })
        .from(tasks)
        .where(
          sql`${tasks.state} IN ('running', 'provisioning') AND ${tasks.lastPodId} IS NOT NULL`,
        )
        .groupBy(tasks.lastPodId);

      const runningCountMap = new Map(runningCounts.map((r) => [r.podId, r.count]));

      // Scaling config per repo
      const repoConfigs =
        repoUrls.length > 0
          ? await db
              .select({
                repoUrl: repos.repoUrl,
                maxConcurrentTasks: repos.maxConcurrentTasks,
                maxPodInstances: repos.maxPodInstances,
                maxAgentsPerPod: repos.maxAgentsPerPod,
              })
              .from(repos)
              .where(inArray(repos.repoUrl, repoUrls))
          : [];

      const repoConfigMap = new Map(repoConfigs.map((r) => [r.repoUrl, r]));

      // Enrich repo pod records with task indicators and scaling config
      // Use the live-derived running count instead of the stored counter, which can drift
      const enrichedRepoPods = repoPodRecords.map((rp) => {
        const config = repoConfigMap.get(rp.repoUrl);
        const liveCount = runningCountMap.get(rp.id) ?? 0;
        return {
          ...rp,
          activeTaskCount: liveCount,
          queuedTaskCount: queuedMap.get(rp.repoUrl) ?? 0,
          maxConcurrentTasks: config?.maxConcurrentTasks ?? 2,
          maxPodInstances: config?.maxPodInstances ?? 1,
          maxAgentsPerPod: config?.maxAgentsPerPod ?? 2,
        };
      });

      reply.send({
        nodes,
        pods,
        services,
        events,
        repoPods: enrichedRepoPods,
        summary: {
          totalPods: pods.length,
          runningPods: pods.filter((p) => p.status === "Running").length,
          agentPods: pods.filter((p) => p.isOptioManaged).length,
          infraPods: pods.filter((p) => p.isInfra).length,
          totalNodes: nodes.length,
          readyNodes: nodes.filter((n) => n.status === "Ready").length,
        },
      });
    } catch (err) {
      reply.status(500).send({ error: String(err) });
    }
  });

  // Keep the existing pod detail endpoints
  app.get("/api/cluster/pods", async (req, reply) => {
    try {
      const workspaceId = req.user?.workspaceId;
      const pods = workspaceId
        ? await db.select().from(repoPods).where(eq(repoPods.workspaceId, workspaceId))
        : await db.select().from(repoPods);
      const podStatuses = await Promise.all(
        pods.map(async (pod) => {
          const recentTasks = await db
            .select({
              id: tasks.id,
              title: tasks.title,
              state: tasks.state,
              agentType: tasks.agentType,
              createdAt: tasks.createdAt,
            })
            .from(tasks)
            .where(eq(tasks.repoUrl, pod.repoUrl))
            .orderBy(desc(tasks.createdAt))
            .limit(10);

          return { ...pod, recentTasks };
        }),
      );
      reply.send({ pods: podStatuses });
    } catch (err) {
      reply.status(500).send({ error: String(err) });
    }
  });

  app.get("/api/cluster/pods/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, id));
    if (!pod) return reply.status(404).send({ error: "Pod not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && pod.workspaceId && pod.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Pod not found" });
    }

    const podTasks = await db
      .select()
      .from(tasks)
      .where(eq(tasks.repoUrl, pod.repoUrl))
      .orderBy(desc(tasks.createdAt))
      .limit(20);

    // Get K8s pod info if we have a pod name
    let k8sPod = null;
    if (pod.podName) {
      try {
        const api = getK8sApi();
        const p = await api.readNamespacedPod({ name: pod.podName, namespace: NAMESPACE });
        const cs = p.status?.containerStatuses?.[0];
        k8sPod = {
          phase: p.status?.phase,
          status: cs?.state?.waiting?.reason ?? (cs?.state?.running ? "Running" : p.status?.phase),
          ready: cs?.ready,
          restarts: cs?.restartCount,
          image: cs?.image ?? p.spec?.containers?.[0]?.image,
          ip: p.status?.podIP,
          nodeName: p.spec?.nodeName,
          startedAt: cs?.state?.running?.startedAt ?? p.status?.startTime,
          resources: p.spec?.containers?.[0]?.resources,
        };
      } catch {
        k8sPod = null;
      }
    }

    // Derive the live active task count from actual running/provisioning tasks
    const [{ count: liveActiveCount }] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(tasks)
      .where(sql`${tasks.state} IN ('running', 'provisioning') AND ${tasks.lastPodId} = ${pod.id}`);

    reply.send({ pod: { ...pod, activeTaskCount: liveActiveCount, tasks: podTasks, k8sPod } });
  });

  // Pod health events
  app.get("/api/cluster/health-events", async (req, reply) => {
    const query = req.query as { limit?: string };
    const limit = query.limit ? parseInt(query.limit, 10) : 50;
    const events = await db
      .select()
      .from(podHealthEvents)
      .orderBy(desc(podHealthEvents.createdAt))
      .limit(limit);
    reply.send({ events });
  });

  // Force restart a repo pod
  app.post("/api/cluster/pods/:id/restart", async (req, reply) => {
    const { id } = req.params as { id: string };
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, id));
    if (!pod) return reply.status(404).send({ error: "Pod not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && pod.workspaceId && pod.workspaceId !== wsId) {
      return reply.status(404).send({ error: "Pod not found" });
    }

    // Destroy the pod
    if (pod.podName) {
      try {
        const { getRuntime } = await import("../services/container-service.js");
        const runtime = getRuntime();
        await runtime.destroy({ id: pod.podId ?? pod.podName, name: pod.podName });
      } catch {}
    }

    // Clear the record — next task will recreate it
    await db.delete(repoPods).where(eq(repoPods.id, id));

    await db.insert(podHealthEvents).values({
      repoPodId: id,
      repoUrl: pod.repoUrl,
      eventType: "restarted",
      podName: pod.podName,
      message: "Manual restart via API",
    });

    reply.send({ ok: true });
  });
}
