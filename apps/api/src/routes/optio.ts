import type { FastifyInstance } from "fastify";
import { KubeConfig, CoreV1Api } from "@kubernetes/client-node";

const NAMESPACE = "optio";
const POD_ROLE_LABEL = "optio.pod-role=optio";

function getK8sApi() {
  const kc = new KubeConfig();
  kc.loadFromDefault();
  return kc.makeApiClient(CoreV1Api);
}

export async function optioRoutes(app: FastifyInstance) {
  app.get("/api/optio/status", async (_req, reply) => {
    try {
      const api = getK8sApi();
      const podList = await api.listNamespacedPod({
        namespace: NAMESPACE,
        labelSelector: POD_ROLE_LABEL,
      });

      const pods = podList.items ?? [];
      if (pods.length === 0) {
        return reply.send({ ready: false, podName: null });
      }

      const pod = pods[0];
      const podName = pod.metadata?.name ?? null;
      const containerStatus = pod.status?.containerStatuses?.[0];
      const isRunning = !!containerStatus?.state?.running;
      const isReady = containerStatus?.ready ?? false;

      reply.send({
        ready: isRunning && isReady,
        podName,
      });
    } catch {
      reply.send({ ready: false, podName: null });
    }
  });
}
