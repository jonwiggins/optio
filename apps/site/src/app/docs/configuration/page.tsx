import type { Metadata } from "next";
import Link from "next/link";
import { CodeBlock } from "@/components/docs/code-block";
import { Callout } from "@/components/docs/callout";

export const metadata: Metadata = {
  title: "Configuration",
  description:
    "Configure Optio with environment variables, Helm values, and per-repo settings. Covers authentication, concurrency limits, agent models, and secrets.",
};

export default function ConfigurationPage() {
  return (
    <>
      <h1 className="text-3xl font-bold text-text-heading">Configuration</h1>
      <p className="mt-4 text-text-muted leading-relaxed">
        Optio is configured through environment variables, Helm chart values, and per-repository
        settings in the dashboard. This page covers all three layers.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Environment Variables</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        These are set on the API server. In Kubernetes, they are configured via the Helm
        chart&apos;s{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">api.env</code>{" "}
        section or directly as environment variables on the deployment.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Core</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Variable</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["DATABASE_URL", "(required)", "PostgreSQL connection string"],
              ["REDIS_URL", "(required)", "Redis connection string for BullMQ and pub/sub"],
              [
                "OPTIO_ENCRYPTION_KEY",
                "(required)",
                "AES-256-GCM key for secret encryption (32-byte hex)",
              ],
              [
                "PUBLIC_URL",
                "http://localhost:30400",
                "Public URL of the API server (used for OAuth callbacks)",
              ],
              ["PORT", "4000", "API server port"],
            ].map(([name, def, desc]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text-heading">{name}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Concurrency &amp; Tuning</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Variable</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["OPTIO_MAX_CONCURRENT", "5", "Global maximum running tasks across all repos"],
              [
                "OPTIO_REPO_POD_IDLE_MS",
                "600000",
                "Idle timeout for repo pods in milliseconds (10 min default)",
              ],
              [
                "OPTIO_REPO_INIT_TIMEOUT_MS",
                "120000",
                "Repo clone/init timeout in milliseconds (2 min default)",
              ],
              ["OPTIO_PR_WATCH_INTERVAL", "30000", "PR polling interval in milliseconds"],
              [
                "OPTIO_HEALTH_CHECK_INTERVAL",
                "60000",
                "Health check and cleanup interval in milliseconds",
              ],
              [
                "OPTIO_IMAGE_PULL_POLICY",
                "IfNotPresent",
                "Kubernetes image pull policy for agent pods (Never for local dev)",
              ],
            ].map(([name, def, desc]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text-heading">{name}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Authentication</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Variable</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["OPTIO_AUTH_DISABLED", "false", "Disable all auth checks (local dev only)"],
              ["GITHUB_OAUTH_CLIENT_ID", "—", "GitHub OAuth app client ID"],
              ["GITHUB_OAUTH_CLIENT_SECRET", "—", "GitHub OAuth app client secret"],
              ["GOOGLE_OAUTH_CLIENT_ID", "—", "Google OAuth client ID"],
              ["GOOGLE_OAUTH_CLIENT_SECRET", "—", "Google OAuth client secret"],
              ["GITLAB_OAUTH_CLIENT_ID", "—", "GitLab OAuth client ID"],
              ["GITLAB_OAUTH_CLIENT_SECRET", "—", "GitLab OAuth client secret"],
              ["GITLAB_OAUTH_BASE_URL", "https://gitlab.com", "Base URL for self-hosted GitLab"],
              ["OIDC_ISSUER_URL", "—", "OIDC issuer URL (enables generic OIDC provider)"],
              ["OIDC_CLIENT_ID", "—", "OIDC client ID"],
              ["OIDC_CLIENT_SECRET", "—", "OIDC client secret"],
              ["OIDC_DISPLAY_NAME", "SSO", "Login button label"],
              ["OIDC_SCOPES", "openid email profile", "Space-separated OIDC scopes"],
            ].map(([name, def, desc]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text-heading">{name}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Callout type="info">
        Enable an OAuth provider by setting both its{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">CLIENT_ID</code>{" "}
        and{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          CLIENT_SECRET
        </code>
        . At least one provider is required for production deployments. Register the callback URL as{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          {"{PUBLIC_URL}/api/auth/{provider}/callback"}
        </code>
        .
      </Callout>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Generic OIDC Provider</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Any OpenID Connect-compatible identity provider (Keycloak, Authentik, Authelia, Zitadel,
        Okta, Auth0, etc.) can be used via the generic OIDC provider. Set{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          OIDC_ISSUER_URL
        </code>{" "}
        to the issuer URL and configure the client credentials. The discovery document is fetched
        automatically from{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          {"<issuer>/.well-known/openid-configuration"}
        </code>
        .
      </p>
      <div className="mt-3">
        <CodeBlock title="Keycloak example">{`OIDC_ISSUER_URL=https://auth.example.com/realms/optio
OIDC_CLIENT_ID=optio
OIDC_CLIENT_SECRET=your-client-secret
OIDC_DISPLAY_NAME="Company SSO"

# Register the callback URL in your IdP:
# {PUBLIC_URL}/api/auth/oidc/callback`}</CodeBlock>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Helm Chart Values</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        The Helm chart at{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">helm/optio/</code>{" "}
        deploys the full stack. Here are the key configuration sections.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Database &amp; Redis</h3>
      <div className="mt-3">
        <CodeBlock title="values.yaml">{`# Use built-in instances (dev only)
postgresql:
  enabled: true
  auth:
    password: "optio_dev"
redis:
  enabled: true

# Use external managed services (production)
postgresql:
  enabled: false
externalDatabase:
  url: "postgresql://user:pass@your-db:5432/optio"
redis:
  enabled: false
externalRedis:
  url: "redis://your-redis:6379"`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Encryption</h3>
      <div className="mt-3">
        <CodeBlock title="terminal">{`# Generate a 32-byte hex key
openssl rand -hex 32`}</CodeBlock>
      </div>
      <div className="mt-3">
        <CodeBlock title="values.yaml">{`encryption:
  key: "your-64-character-hex-string-here"`}</CodeBlock>
      </div>

      <Callout type="warning">
        The encryption key is required and is used for AES-256-GCM encryption of all secrets stored
        in the database. Losing this key means losing access to all stored secrets.
      </Callout>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Agent Images</h3>
      <div className="mt-3">
        <CodeBlock title="values.yaml">{`agent:
  # For local dev (images loaded directly into K8s containerd)
  imagePullPolicy: Never

  # For production (images in a container registry)
  imagePullPolicy: IfNotPresent
  # or: Always`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Ingress</h3>
      <div className="mt-3">
        <CodeBlock title="values.yaml">{`ingress:
  enabled: true
  hosts:
    - host: optio.example.com
  tls: true`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Services</h3>
      <div className="mt-3">
        <CodeBlock title="values.yaml">{`# Local dev (NodePort for direct access)
api:
  service:
    type: NodePort
    nodePort: 30400
web:
  service:
    type: NodePort
    nodePort: 30310

# Production (ClusterIP behind ingress)
api:
  service:
    type: ClusterIP
web:
  service:
    type: ClusterIP`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Auth</h3>
      <div className="mt-3">
        <CodeBlock title="values.yaml">{`auth:
  # Disable for local development
  disabled: true

  # Production: configure OAuth providers
  github:
    clientId: "your-client-id"
    clientSecret: "your-client-secret"
  google:
    clientId: "your-client-id"
    clientSecret: "your-client-secret"`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">What the Chart Creates</h3>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>Namespace, ServiceAccount, and RBAC (pod/exec/secret management)</li>
        <li>API deployment + service with health probes</li>
        <li>Web deployment + service</li>
        <li>Conditional PostgreSQL and Redis deployments</li>
        <li>Configurable Ingress resource</li>
      </ul>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Per-Repository Settings</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Each connected repository has its own settings, configured in the dashboard under{" "}
        <strong className="text-text-heading">Repos &rarr; Settings</strong>.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">General</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["imagePreset", "auto-detect", "Agent image: node, python, go, rust, full"],
              ["defaultBranch", "main", "Branch to create worktrees from"],
              ["autoMerge", "false", "Auto-merge PRs when CI passes and review is approved"],
              ["autoResume", "true", "Auto-resume agent when reviewer requests changes"],
              ["maxConcurrentTasks", "2", "Max concurrent tasks in this repo"],
              ["maxPodInstances", "1", "Max pod replicas for this repo (1-20)"],
              ["maxAgentsPerPod", "2", "Max concurrent agents per pod (1-50)"],
            ].map(([name, def, desc]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text-heading">{name}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Claude Settings</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["claudeModel", "sonnet", "Model for coding tasks (sonnet, opus, haiku)"],
              ["claudeContextWindow", "null", "Context window override (null = model default)"],
              ["claudeThinking", "false", "Enable extended thinking mode"],
              ["claudeEffort", "null", "Effort level override"],
              ["maxTurnsCoding", "null", "Max agent turns for coding tasks"],
              ["maxTurnsReview", "null", "Max agent turns for review tasks"],
              ["promptTemplateOverride", "null", "Custom prompt template for this repo"],
            ].map(([name, def, desc]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text-heading">{name}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Review Settings</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Setting</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Default</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["reviewEnabled", "false", "Enable automatic code review agent"],
              ["reviewTrigger", "on_ci_pass", "When to trigger: on_ci_pass or on_pr"],
              ["reviewModel", "sonnet", "Model to use for review (often a cheaper model)"],
              ["reviewPromptTemplate", "null", "Custom review prompt template"],
            ].map(([name, def, desc]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text-heading">{name}</td>
                <td className="px-4 py-3 text-text-muted">{def}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Prompt Templates</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        System prompts use a simple template language with variable substitution and conditionals.
      </p>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Available Variables</h3>
      <div className="mt-4 overflow-hidden rounded-xl border border-border bg-bg-card">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="border-b border-border bg-bg-subtle">
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Variable</th>
              <th className="px-4 py-3 text-left font-semibold text-text-heading">Description</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[
              ["{{TASK_FILE}}", "Path to the task description markdown file"],
              ["{{BRANCH_NAME}}", "Git branch name for this task"],
              ["{{TASK_ID}}", "Unique task identifier"],
              ["{{TASK_TITLE}}", "Task title"],
              ["{{REPO_NAME}}", "Repository name (owner/repo)"],
              ["{{AUTO_MERGE}}", "Whether auto-merge is enabled"],
              ["{{PR_NUMBER}}", "PR number (review tasks only)"],
              ["{{TEST_COMMAND}}", "Detected test command (review tasks only)"],
            ].map(([variable, desc]) => (
              <tr key={variable}>
                <td className="px-4 py-3 font-mono text-text-heading">{variable}</td>
                <td className="px-4 py-3 text-text-muted">{desc}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Conditionals</h3>
      <div className="mt-3">
        <CodeBlock title="prompt template">{`{{#if AUTO_MERGE}}
After CI passes, the PR will be auto-merged.
{{else}}
Wait for manual review before merging.
{{/if}}`}</CodeBlock>
      </div>

      <h3 className="mt-6 text-lg font-semibold text-text-heading">Priority Chain</h3>
      <p className="mt-3 text-text-muted leading-relaxed">
        Templates are resolved in order of specificity:
      </p>
      <ol className="mt-3 list-decimal pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          Per-repo override (
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            repos.promptTemplateOverride
          </code>
          )
        </li>
        <li>
          Global default (
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            prompt_templates
          </code>{" "}
          table)
        </li>
        <li>
          Hardcoded fallback in{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            @optio/shared
          </code>
        </li>
      </ol>
      <p className="mt-3 text-text-muted leading-relaxed">
        Review prompts follow the same chain:{" "}
        <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
          repos.reviewPromptTemplate
        </code>{" "}
        &rarr; default review template.
      </p>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Secrets</h2>
      <p className="mt-3 text-text-muted leading-relaxed">
        Secrets are managed in the dashboard under{" "}
        <strong className="text-text-heading">Secrets</strong> and are encrypted at rest with
        AES-256-GCM. Key secrets to configure:
      </p>
      <ul className="mt-3 list-disc pl-5 space-y-1 text-[14px] text-text-muted">
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            CLAUDE_AUTH_MODE
          </code>{" "}
          — <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">api-key</code>{" "}
          or{" "}
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            oauth-token
          </code>
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            ANTHROPIC_API_KEY
          </code>{" "}
          — Your API key (if using api-key mode)
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            CLAUDE_CODE_OAUTH_TOKEN
          </code>{" "}
          — OAuth token (if using oauth-token mode)
        </li>
        <li>
          <code className="rounded bg-bg-hover px-1.5 py-0.5 text-[13px] font-mono">
            GITHUB_TOKEN
          </code>{" "}
          — GitHub personal access token for PR watching, issue sync, and repo detection
        </li>
      </ul>

      <Callout type="tip">
        Secret values are never logged or returned via the API. Only secret names and scopes are
        visible in the dashboard.
      </Callout>

      <h2 className="mt-10 text-2xl font-bold text-text-heading">Next Steps</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {[
          {
            title: "Deployment",
            href: "/docs/deployment",
            description: "Production deployment checklist",
          },
          {
            title: "Connecting Repos",
            href: "/docs/guides/connecting-repos",
            description: "Per-repo settings and image presets",
          },
          {
            title: "Review Agents",
            href: "/docs/guides/review-agents",
            description: "Configure automated code review",
          },
          {
            title: "API Reference",
            href: "/docs/api-reference",
            description: "Full REST API documentation",
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
