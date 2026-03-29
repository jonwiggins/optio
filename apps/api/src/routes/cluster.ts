import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { KubeConfig, CoreV1Api, AppsV1Api, CustomObjectsApi } from "@kubernetes/client-node";
import { db } from "../db/client.js";
import { repoPods, tasks, podHealthEvents, repos } from "../db/schema.js";
import { eq, desc, and, inArray, sql } from "drizzle-orm";
import { requireRole } from "../plugins/auth.js";
import { getVersionInfo, isLocalDev } from "../services/version-service.js";

const healthEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(50),
});

function getK8sConfig() {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc;
}

function getK8sApi() {
  return getK8sConfig().makeApiClient(CoreV1Api);
}

const NAMESPACE = "optio";

function getAppsApi() {
  return getK8sConfig().makeApiClient(AppsV1Api);
}

function getMetricsApi() {
  return getK8sConfig().makeApiClient(CustomObjectsApi);
}

/** Fetch metrics from the K8s Metrics API via the client library */
async function fetchNodeMetrics(): Promise<NodeMetrics[] | null> {
  try {
    const api = getMetricsApi();
    const res = await api.listClusterCustomObject({
      group: "metrics.k8s.io",
      version: "v1beta1",
      plural: "nodes",
    });
    return (res as any).items ?? null;
  } catch {
    return null;
  }
}

async function fetchPodMetrics(namespace: string): Promise<PodMetrics[] | null> {
  try {
    const api = getMetricsApi();
    const res = await api.listNamespacedCustomObject({
      group: "metrics.k8s.io",
      version: "v1beta1",
      namespace,
      plural: "pods",
    });
    return (res as any).items ?? null;
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
  // Cluster overview: nodes, all pods, services, resource summary — admin only
  app.get("/api/cluster/overview", { preHandler: [requireRole("admin")] }, async (req, reply) => {
    try {
      const api = getK8sApi();

      const [nodeList, podList, serviceList, eventList] = await Promise.all([
        api.listNode({ limit: 50 }),
        api.listNamespacedPod({ namespace: NAMESPACE }),
        api.listNamespacedService({ namespace: NAMESPACE }),
        api.listNamespacedEvent({ namespace: NAMESPACE, limit: 30 }),
      ]);

      // Fetch metrics (gracefully fail if metrics-server not installed)
      const [nodeMetricsItems, podMetricsItems] = await Promise.all([
        fetchNodeMetrics(),
        fetchPodMetrics(NAMESPACE),
      ]);

      const nodeMetricsMap = new Map(
        (nodeMetricsItems ?? []).map((m) => [m.metadata.name, m.usage]),
      );
      const podMetricsMap = new Map(
        (podMetricsItems ?? []).map((m) => [
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
        metricsAvailable: nodeMetricsItems !== null,
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

  // Keep the existing pod detail endpoints — admin only
  app.get("/api/cluster/pods", { preHandler: [requireRole("admin")] }, async (req, reply) => {
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

  app.get("/api/cluster/pods/:id", { preHandler: [requireRole("admin")] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, id));
    if (!pod) return reply.status(404).send({ error: "Pod not found" });
    const wsId = req.user?.workspaceId;
    if (wsId && pod.workspaceId !== wsId) {
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

  // Pod health events — admin only
  app.get(
    "/api/cluster/health-events",
    { preHandler: [requireRole("admin")] },
    async (req, reply) => {
      const parsed = healthEventsQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.issues[0].message });
      }
      const limit = parsed.data.limit;
      const events = await db
        .select()
        .from(podHealthEvents)
        .orderBy(desc(podHealthEvents.createdAt))
        .limit(limit);
      reply.send({ events });
    },
  );

  // Force restart a repo pod — admin only
  app.post(
    "/api/cluster/pods/:id/restart",
    { preHandler: [requireRole("admin")] },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, id));
      if (!pod) return reply.status(404).send({ error: "Pod not found" });
      const wsId = req.user?.workspaceId;
      if (wsId && pod.workspaceId !== wsId) {
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
    },
  );

  // Version check — any authenticated user can read
  app.get("/api/cluster/version", async (_req, reply) => {
    try {
      const info = await getVersionInfo();
      reply.send(info);
    } catch (err) {
      reply.status(500).send({ error: String(err) });
    }
  });

  // Trigger update — admin only
  const updateBodySchema = z.object({
    targetVersion: z.string().regex(/^\d+\.\d+\.\d+$/, "Must be a valid semver version"),
  });

  app.post("/api/cluster/update", { preHandler: [requireRole("admin")] }, async (req, reply) => {
    if (isLocalDev()) {
      return reply
        .status(400)
        .send({ error: "Self-update is not available in local development mode" });
    }

    const parsed = updateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0].message });
    }
    const { targetVersion } = parsed.data;

    const imageOwner = process.env.OPTIO_IMAGE_OWNER ?? "jonwiggins";
    const registry = "ghcr.io";

    const deployments = [
      { name: "optio-api", image: `${registry}/${imageOwner}/optio-api:${targetVersion}` },
      { name: "optio-web", image: `${registry}/${imageOwner}/optio-web:${targetVersion}` },
    ];

    try {
      const appsApi = getAppsApi();

      for (const dep of deployments) {
        try {
          await appsApi.patchNamespacedDeployment({
            name: dep.name,
            namespace: NAMESPACE,
            body: {
              spec: {
                template: {
                  spec: {
                    containers: [{ name: dep.name, image: dep.image }],
                  },
                },
              },
            },
          });
        } catch (depErr: any) {
          // If a deployment doesn't exist, skip it
          if (depErr?.response?.statusCode === 404) continue;
          throw depErr;
        }
      }

      reply.send({
        ok: true,
        targetVersion,
        message: `Rolling update to v${targetVersion} initiated. The API will restart shortly.`,
      });
    } catch (err) {
      reply.status(500).send({ error: `Failed to trigger update: ${String(err)}` });
    }
  });
}
