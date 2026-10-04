import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Deployment",
  description:
    "Deploy Optio to production Kubernetes with Helm. Covers TLS, managed Postgres and Redis, OAuth setup, encryption, and the full deployment checklist.",
};

export default function DeploymentPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Production Deployment</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        This guide walks through deploying Optio to a production Kubernetes cluster. Optio ships as
        a Helm chart that deploys the API server, web dashboard, and supporting infrastructure.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Prerequisites</h2>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          A Kubernetes cluster (1.24+) with{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">kubectl</code>{" "}
          configured
        </li>
        <li>Helm 3+</li>
        <li>Managed PostgreSQL instance</li>
        <li>Managed Redis instance</li>
        <li>A domain name with DNS configured</li>
        <li>TLS certificate (or cert-manager for automatic provisioning)</li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Deployment Checklist</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Work through each item before going live. Every item marked as required must be completed.
      </p>

      <div className="mt-6 space-y-4">
        <h3 className="text-lg font-semibold text-text-heading">1. Generate an Encryption Key</h3>
        <p className="text-text-muted leading-relaxed">
          All secrets stored in the database are encrypted with AES-256-GCM. Generate a key and keep
          it safe — losing it means losing access to all stored secrets.
        </p>
        <CodeBlock title="terminal">{`openssl rand -hex 32`}</CodeBlock>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">2. Configure sign-in</h3>
        <p className="text-text-muted leading-relaxed">
          The simplest path for an organization: install with no provider and configure{" "}
          <strong>Google Workspace</strong> sign-in from the setup wizard. Open the web UI; it sends
          you to the wizard&apos;s Sign-in step, which asks for the one-time setup token the API
          prints in its log:
        </p>
        <CodeBlock title="terminal">{`kubectl logs -n optio deploy/optio-api | grep "setup token"`}</CodeBlock>
        <p className="mt-3 text-text-muted leading-relaxed">
          In the Google Cloud Console create an OAuth client (Web application) with the redirect URI
          the step shows, paste its client ID and secret, list the Google Workspace domains allowed
          to sign in, name your organization, and sign in. You become the deployment admin (the only
          role that can change sign-in), and everyone from the allowed domains joins your workspace
          as a member when they sign in. Later changes live in Settings → Access → Sign-in.
        </p>
        <p className="mt-3 text-text-muted leading-relaxed">
          Any provider — GitHub, Google, GitLab, generic OIDC — can also be set by environment
          variables (see Configuration). Register its callback URL as:
        </p>
        <CodeBlock>{`https://optio.example.com/api/auth/{provider}/callback`}</CodeBlock>

        <Callout type="warning">
          Ensure{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            OPTIO_AUTH_DISABLED
          </code>{" "}
          is NOT set (or is set to{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">false</code>) in
          production. Leaving auth disabled exposes the entire system without authentication.
        </Callout>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">3. Use External Databases</h3>
        <p className="text-text-muted leading-relaxed">
          The built-in PostgreSQL and Redis instances are single-node with no replication. Always
          use managed services in production.
        </p>
        <CodeBlock title="values.production.yaml">{`postgresql:
  enabled: false
externalDatabase:
  url: "postgresql://user:pass@your-rds-host:5432/optio"

redis:
  enabled: false
externalRedis:
  url: "redis://your-elasticache-host:6379"`}</CodeBlock>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">4. Set the Public URL</h3>
        <p className="text-text-muted leading-relaxed">
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            PUBLIC_URL
          </code>{" "}
          must match the actual deployment URL. This is used for OAuth callback URLs, webhook URLs,
          and the web app&apos;s API connection.
        </p>
        <CodeBlock title="values.production.yaml">{`api:
  env:
    PUBLIC_URL: "https://optio.example.com"`}</CodeBlock>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">5. Configure Ingress</h3>
        <p className="text-text-muted leading-relaxed">
          Enable ingress with TLS to expose Optio externally.
        </p>
        <CodeBlock title="values.production.yaml">{`ingress:
  enabled: true
  hosts:
    - host: optio.example.com
  tls: true
  annotations:
    # Example for cert-manager
    cert-manager.io/cluster-issuer: letsencrypt-prod`}</CodeBlock>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">
          6. Push Agent Images to a Registry
        </h3>
        <p className="text-text-muted leading-relaxed">
          Build agent images and push them to a container registry accessible by your cluster.
        </p>
        <CodeBlock title="terminal">{`# Build all presets (base, node, python, go, rust, full)
./images/build.sh

# Tag and push to your registry
docker tag optio-agent-node:latest registry.example.com/optio-agent-node:latest
docker push registry.example.com/optio-agent-node:latest`}</CodeBlock>
        <CodeBlock title="values.production.yaml">{`agent:
  imagePullPolicy: IfNotPresent
  # or: Always (to pick up image updates on every task)`}</CodeBlock>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">7. Set Up a GitHub Token</h3>
        <p className="text-text-muted leading-relaxed">
          A GitHub personal access token is required for PR watching, issue synchronization, and
          repository language detection. Add it as a secret in the Optio dashboard after first
          login, or set it via the setup wizard.
        </p>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">8. Tune Resource Limits</h3>
        <p className="text-text-muted leading-relaxed">
          Adjust pod resource requests and limits based on your expected agent workload. Agents can
          be memory-intensive, especially for large repositories.
        </p>

        <h3 className="mt-8 text-lg font-semibold text-text-heading">9. Install metrics-server</h3>
        <p className="text-text-muted leading-relaxed">
          Optio&apos;s cluster monitoring page requires the Kubernetes metrics-server to display
          resource usage data. Most managed Kubernetes services include it, but verify:
        </p>
        <CodeBlock title="terminal">{`kubectl top nodes
# If this errors, install metrics-server:
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Full Production Values</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Here is a complete example{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          values.production.yaml
        </code>{" "}
        combining all the above:
      </p>
      <div className="mt-3">
        <CodeBlock title="values.production.yaml">{`api:
  replicas: 2
  env:
    PUBLIC_URL: "https://optio.example.com"

web:
  replicas: 2
  env:
    NEXT_PUBLIC_API_URL: "https://optio.example.com/api"
    NEXT_PUBLIC_WS_URL: "wss://optio.example.com"

encryption:
  key: "<your-64-char-hex-key>"

postgresql:
  enabled: false
externalDatabase:
  url: "postgresql://user:pass@your-db:5432/optio"

redis:
  enabled: false
externalRedis:
  url: "redis://your-redis:6379"

auth:
  github:
    clientId: "your-github-oauth-client-id"
    clientSecret: "your-github-oauth-client-secret"

agent:
  imagePullPolicy: IfNotPresent

ingress:
  enabled: true
  hosts:
    - host: optio.example.com
  tls: true`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Install</h2>
      <div className="mt-3">
        <CodeBlock title="terminal">{`helm install optio helm/optio \\
  -f values.production.yaml \\
  --namespace optio \\
  --create-namespace`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Upgrading</h2>
      <p className="mt-3 text-text-muted leading-relaxed">To upgrade an existing deployment:</p>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# Upgrade with new values or chart version
helm upgrade optio helm/optio \\
  -f values.production.yaml \\
  --namespace optio

# Or reuse existing values and only change specific settings
helm upgrade optio helm/optio \\
  --namespace optio \\
  --reuse-values \\
  --set api.replicas=3`}</CodeBlock>
      </div>

      <Callout type="info">
        Database migrations run automatically when the API server starts. No manual migration step
        is needed during upgrades.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Performance Tuning</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Once deployed, tune these settings based on your workload:
      </p>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["OPTIO_MAX_CONCURRENT", "5", "Increase for clusters with more resources"],
              ["maxPodInstances", "1/repo", "Scale up for repos with high throughput"],
              ["maxAgentsPerPod", "2/pod", "Increase if pods have sufficient CPU/memory"],
              [
                "OPTIO_REPO_POD_IDLE_MS",
                "10 min",
                "Increase to reduce cold starts for sporadic repos",
              ],
              ["OPTIO_PR_WATCH_INTERVAL", "30s", "Increase to reduce GitHub API rate limit usage"],
              ["maxTurnsCoding", "null", "Set per-repo to limit agent cost and runtime"],
            ].map(([setting, def, notes]) => (
              <tr key={setting}>
                <td className="px-4 py-3 font-mono text-text-heading">{setting}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Troubleshooting</h2>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Pod won&apos;t start</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# Check pod status and events
kubectl get pods -n optio
kubectl describe pod <pod-name> -n optio

# Verify agent images exist
kubectl get pods -n optio -o jsonpath='{.items[*].spec.containers[*].image}'

# Check PVC availability
kubectl get pvc -n optio`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Agent fails with auth error</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          Verify{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            CLAUDE_AUTH_MODE
          </code>{" "}
          secret is set to{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">api-key</code>{" "}
          or{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            oauth-token
          </code>
        </li>
        <li>
          For API key mode: ensure{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            ANTHROPIC_API_KEY
          </code>{" "}
          secret exists
        </li>
        <li>
          For OAuth token mode: ensure{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            CLAUDE_CODE_OAUTH_TOKEN
          </code>{" "}
          secret exists
        </li>
        <li>
          Check token validity via{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            GET /api/auth/status
          </code>
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Tasks stuck in queued</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          Check concurrency limits:{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            OPTIO_MAX_CONCURRENT
          </code>{" "}
          and per-repo{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            maxConcurrentTasks
          </code>
        </li>
        <li>
          Look for stuck tasks in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            provisioning
          </code>{" "}
          or{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">running</code>{" "}
          state that may need manual cancellation
        </li>
        <li>Check the API server logs for re-queue messages</li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">OAuth login fails</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          Verify{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            PUBLIC_URL
          </code>{" "}
          matches the actual deployment URL
        </li>
        <li>Ensure the OAuth callback URL is registered with the provider</li>
        <li>
          Check for{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            invalid_state
          </code>{" "}
          errors, which indicate expired CSRF tokens (10 min TTL)
        </li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Teardown</h2>
      <div className="mt-3">
        <CodeBlock title="terminal">{`helm uninstall optio -n optio`}</CodeBlock>
      </div>

      <Callout type="warning">
        This removes all Optio deployments and services. Your external database and Redis data are
        preserved if you used managed services. Built-in PostgreSQL data will be lost.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Configuration",
            href: "/docs/configuration",
            description: "All environment variables and Helm values",
          },
          {
            title: "Integrations",
            href: "/docs/guides/integrations",
            description: "Connect GitHub Issues, GitLab Issues, Linear, Jira, Notion, Slack",
          },
          {
            title: "API Reference",
            href: "/docs/api-reference",
            description: "REST API documentation",
          },
          {
            title: "Contributing",
            href: "/docs/contributing",
            description: "Development setup and conventions",
          },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className="card-hover rounded-lg border border-border bg-bg-card p-4 block"
          >
            <p className="text-[14px] font-semibold text-text-heading">{item.title}</p>
            <p className="mt-1 text-[13px] text-text-muted">{item.description}</p>
          </Link>
        ))}
      </div>
    </>
  );
}
