import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Deployment",
  description:
    "Deploy Optio with Helm, managed PostgreSQL and Redis, existing Kubernetes Secrets, and a single combined API/web pod. Includes recovery and upgrade limitations.",
};

export default function DeploymentPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Production deployment</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Use the Helm chart with managed PostgreSQL and Redis, an ingress with TLS, and your
        organization’s sign-in provider. Start from the checked-in{" "}
        <a
          className="text-primary-light hover:underline"
          href="https://github.com/jonwiggins/optio/blob/main/helm/optio/values.production.yaml"
        >
          production values
        </a>{" "}
        and adapt the hostname, storage classes, resources, and network policy to your cluster.
      </p>
      <div className="mt-6">
        <Callout type="warning">
          Optio currently requires one combined API/web replica. The API owns in-memory Local
          relays, session broadcasts, and cancellation state. Keep api.replicas at 1 and API
          autoscaling disabled. Recreate upgrades include a brief control-plane outage; this is not
          a highly available API. Agent pods scale independently.
        </Callout>
      </div>
      <h2 className="mt-10 text-2xl font-bold text-text-heading">
        Managed services and existing Secrets
      </h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Provision Secrets in the Optio namespace through your secret manager, then reference their
        keys. Helm does not need to read their contents. Redis must retain queue state without
        evicting queue keys; configure database and Redis TLS according to your managed services.
        Redis Cluster and Amazon ElastiCache Serverless run with{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          externalRedis.mode: cluster
        </code>
        , which keeps every queue under one hash-tagged key prefix. The{" "}
        <a
          className="text-primary-light hover:underline"
          href="https://github.com/jonwiggins/optio/blob/main/docs/redis.md"
        >
          Redis guide
        </a>{" "}
        covers TLS, authentication, eviction behavior, capacity alarms, and a smoke test to run
        before switching.
      </p>
      <CodeBlock title="values.production.yaml">{`publicUrl: https://optio.example.com
api:
  replicas: 1
  strategy:
    type: Recreate
  autoscaling:
    enabled: false
postgresql:
  enabled: false
redis:
  enabled: false
auth:
  disabled: false
existingSecrets:
  DATABASE_URL: { name: optio-runtime, key: database-url }
  REDIS_URL: { name: optio-runtime, key: redis-url }
  OPTIO_ENCRYPTION_KEY: { name: optio-runtime, key: encryption-key }
  GOOGLE_OAUTH_CLIENT_ID: { name: optio-sign-in, key: client-id }
  GOOGLE_OAUTH_CLIENT_SECRET: { name: optio-sign-in, key: client-secret }`}</CodeBlock>
      <p className="mt-3 text-text-muted leading-relaxed">
        The same mechanism supports GitHub/GitLab OAuth, generic OIDC, and other API environment
        settings. Secret references override inline settings. Missing keys prevent startup. Restart
        the deployment after rotating an external Secret so containers receive the new environment
        values.
      </p>
      <CodeBlock title="Generate the encryption key once">{`openssl rand -hex 32`}</CodeBlock>
      <Callout type="warning">
        Back up the encryption key separately and retain the same key across upgrades and restores.
        Replacing it makes saved credentials unreadable; changing a Secret is not an encryption-key
        migration.
      </Callout>
      <h2 className="mt-10 text-2xl font-bold text-text-heading">Sign-in and ingress</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Configure OAuth or OIDC through existing Secrets, or use the bootstrap wizard for
        organization Google sign-in. Keep authentication enabled. Set publicUrl to the
        browser-facing HTTPS origin and use the production values’ ingress paths for /, /api, and
        /ws, with a valid TLS certificate and WebSocket timeouts.
      </p>
      <p className="mt-3 text-text-muted leading-relaxed">
        The combined pod contains separate API and web containers. There is no independent web
        replica setting. With a shared ingress origin, the web app’s API and WebSocket connections
        use that origin.
      </p>
      <h2 className="mt-10 text-2xl font-bold text-text-heading">Storage and worker identity</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        On EKS, install the EBS CSI driver and choose a StorageClass available in your cluster. Repo
        StatefulSets keep home and workspace claims; retained claims need their own capacity
        planning, backups, and cleanup policy.
      </p>
      <CodeBlock title="Worker settings">{`agent:
  pvc:
    storageClass: gp3 # example; must exist in your cluster
    size: 10Gi
  cache:
    storageClass: gp3
  serviceAccount:
    create: true
    annotations: {} # configure an agent IAM role only if needed`}</CodeBlock>
      <p className="mt-3 text-text-muted leading-relaxed">
        Agents have a separate service account, no API control-plane RBAC, and no automounted
        Kubernetes token. Use scoped Connections for per-owner credentials. Pool isolation includes
        workspace, owner, purpose, and explicit access settings; work within one pool is mutually
        trusted. Pods share a kernel and are not a sufficient boundary for hostile tenants.
      </p>
      <h2 className="mt-10 text-2xl font-bold text-text-heading">Install and upgrade</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Use the chart from the release you intend to deploy and pin matching API, web, and agent
        image versions. Back up PostgreSQL, the encryption key, and needed PVC data first.
      </p>
      <CodeBlock title="From the matching release checkout">{`helm upgrade --install optio helm/optio \\
  --namespace optio --create-namespace \\
  -f values.production.yaml

kubectl rollout status deployment/optio-api -n optio`}</CodeBlock>
      <p className="mt-3 text-text-muted leading-relaxed">
        Database migrations run at API startup. Local daemons reconnect with their existing PTYs.
        Pod terminals use tmux to reconnect to an existing shell, but a recreated pod loses its
        processes even when its files survive on a persistent volume.
      </p>
      <h2 className="mt-10 text-2xl font-bold text-text-heading">Understand recovery</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Session status distinguishes live, reconnecting, resumable, lost, and ended. An uncertain
        execution outcome requires inspection before retrying; it is not treated as successful
        completion or blindly replayed. Durable chat receipts prevent the same accepted request ID
        from starting another turn after restart. External side effects still need application-level
        idempotency or human review.
      </p>
      <p className="mt-6 text-text-muted leading-relaxed">
        Read the{" "}
        <a
          className="text-primary-light hover:underline"
          href="https://github.com/jonwiggins/optio/blob/main/docs/production-eks.md"
        >
          complete EKS, recovery, and collaboration guide
        </a>{" "}
        for migration handling, legacy pods, claim retention, and sharing boundaries. See the{" "}
        <Link href="/docs/configuration" className="text-primary-light hover:underline">
          configuration reference
        </Link>{" "}
        for other settings.
      </p>
    </>
  );
}
