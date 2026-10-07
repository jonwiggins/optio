import type { Metadata } from "next";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Installation",
  description:
    "Install Optio locally with Docker Desktop or deploy to a production Kubernetes cluster. Step-by-step prerequisites, Helm setup, and verification.",
};

export default function InstallationPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Installation</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Optio runs on Kubernetes. You can run it locally with Docker Desktop or deploy to a
        production cluster with the Helm chart.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Local Development</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The quickest path uses Docker Desktop&apos;s built-in Kubernetes cluster.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Prerequisites</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <strong className="text-text-heading">Docker Desktop</strong> with Kubernetes enabled
          (Settings &rarr; Kubernetes &rarr; Enable)
        </li>
        <li>
          <strong className="text-text-heading">Node.js 22+</strong> and{" "}
          <strong className="text-text-heading">pnpm 10+</strong>
        </li>
        <li>
          <strong className="text-text-heading">Helm 3+</strong> and{" "}
          <strong className="text-text-heading">kubectl</strong>
        </li>
      </ul>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Automated Setup</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`git clone https://github.com/jonwiggins/optio.git
cd optio
./scripts/setup-local.sh`}</CodeBlock>
      </div>
      <p className="mt-4 text-text-muted leading-relaxed">
        The setup script performs the following:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-1 text-[14px] text-text-muted">
        <li>Checks all prerequisites are installed</li>
        <li>
          Runs{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            pnpm install
          </code>
        </li>
        <li>Builds all agent images (base, node, python, go, rust, full)</li>
        <li>Builds API and web Docker images</li>
        <li>Installs the Kubernetes metrics-server</li>
        <li>Deploys via Helm with NodePort services (API: 30400, Web: 30310)</li>
      </ol>

      <Callout type="tip">
        After the initial setup, use{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          ./scripts/update-local.sh
        </code>{" "}
        to pull the latest changes, rebuild, and redeploy without starting from scratch.
      </Callout>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Hot Reload (API + Web)</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        For iterating on the API or web UI without rebuilding Docker images:
      </p>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# Start API and web with hot reload
pnpm dev

# Or individually
pnpm dev:api   # Fastify API on :4000
pnpm dev:web   # Next.js on :3100`}</CodeBlock>
      </div>

      <Callout type="info">
        When running locally with{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">pnpm dev</code>,
        you still need Kubernetes running for pod provisioning. The API connects to K8s via kubectl
        context.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Production Deployment</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        For production, deploy the Helm chart to your Kubernetes cluster. Images are published to
        GitHub Container Registry (GHCR) on each release.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Helm Install</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# Add the Optio Helm repository
helm install optio oci://ghcr.io/jonwiggins/optio/helm/optio \\
  -f values.production.yaml \\
  --namespace optio \\
  --create-namespace`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Key Production Settings</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Create a{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          values.production.yaml
        </code>{" "}
        with references to Secrets you have already provisioned. Start from
        helm/optio/values.production.yaml for the complete ingress and resource settings:
      </p>
      <div className="mt-3">
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
  GOOGLE_OAUTH_CLIENT_SECRET: { name: optio-sign-in, key: client-secret }
# Add your ingress, TLS, and storage settings from the production example.`}</CodeBlock>
      </div>

      <Callout type="warning">
        Always use managed PostgreSQL and Redis in production. The built-in instances are
        single-node with no replication and are intended for development only. The combined API/web
        pod currently requires one replica and Recreate upgrades; agent pods scale independently.
      </Callout>

      <p className="mt-4 text-text-muted leading-relaxed">
        See the{" "}
        <a href="/docs/deployment" className="text-primary-light hover:underline">
          Deployment guide
        </a>{" "}
        for the full production checklist and the{" "}
        <a href="/docs/configuration" className="text-primary-light hover:underline">
          Configuration reference
        </a>{" "}
        for all available Helm values.
      </p>
    </>
  );
}
