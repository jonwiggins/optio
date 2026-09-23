/**
 * Keeps the API servers the test tiers start (startApiServer: every pipeline
 * e2e file and the web e2e stack) off the machine they run on. They run next
 * to the developer's real Optio, and would otherwise inherit its:
 *
 *  - kubeconfig: /api/cluster/* read (and /api/cluster/update patches) the
 *    real cluster, the boot-time metrics probe calls it, and the shared
 *    directory / network policy code shells out to `kubectl` against it;
 *  - Claude login: auth-service reads the Keychain (`security`) and
 *    ~/.claude/.credentials.json, so /api/auth/status, /api/auth/usage and the
 *    token-validation worker would send the real OAuth token to Anthropic,
 *    and an auth-disabled test server's /api/auth/claude-token would hand it
 *    to anyone who asks;
 *  - shell credentials and Optio settings (GITHUB_TOKEN, ANTHROPIC_API_KEY,
 *    AWS_*, OPTIO_*, ...).
 *
 * createHermeticEnv() serves a small read-only Kubernetes API from this
 * process (writes answer 403), puts failing `kubectl` / `helm` stubs and a
 * `security` stub (errSecItemNotFound) first on PATH, and points HOME and
 * CLAUDE_CONFIG_DIR at empty directories. hermeticBaseEnv() drops the
 * credentials and settings from an inherited environment.
 */
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Inherited variables a test API server must not see. */
const STRIPPED_ENV: RegExp[] = [
  // Developer / deployment settings; keep the test infra URLs and the
  // encryption key the test process itself encrypts seeded secrets with.
  /^OPTIO_(?!TEST_|ENCRYPTION_KEY$)/,
  /^(GITHUB|GH|GITLAB|LINEAR|SLACK|SENTRY|NOTION|JIRA|OIDC|GOOGLE)_/,
  /^(ANTHROPIC|OPENAI|GEMINI|CURSOR|OPENCODE|COPILOT)_/,
  /^CLAUDE_/,
  /^(AWS|AZURE)_/,
  /^KUBECONFIG$/,
];

/** `env` minus anything that could point a test server at real accounts or clusters. */
export function hermeticBaseEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || STRIPPED_ENV.some((re) => re.test(key))) continue;
    out[key] = value;
  }
  return out;
}

export interface HermeticEnv {
  /** Overrides for the server process: PATH, KUBECONFIG, HOME, CLAUDE_CONFIG_DIR. */
  env: Record<string, string>;
  /** The stub directory; keep it first on PATH (see withStubsFirst). */
  binDir: string;
  /** Base URL of the fake Kubernetes API. */
  kubeUrl: string;
  /** Stop the fake API and remove the scratch directory. */
  stop(): Promise<void>;
}

const NAMESPACE = "optio";

type KubeItem = Record<string, unknown> & {
  metadata: Record<string, unknown> & { labels?: Record<string, string> };
};
interface KubeList {
  kind: string;
  apiVersion: string;
  metadata: Record<string, never>;
  items: KubeItem[];
}

/** Fixture objects for the cluster pages: one node, Optio's pods, services, events, metrics. */
function clusterFixture() {
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const HOUR = 3600_000;
  const pod = (name: string, image: string, labels: Record<string, string>, ageMs: number) => ({
    metadata: {
      name,
      namespace: NAMESPACE,
      uid: randomUUID(),
      creationTimestamp: iso(ageMs),
      labels,
    },
    spec: { nodeName: "test-node", containers: [{ name: "main", image }] },
    status: {
      phase: "Running",
      podIP: "10.1.0.10",
      startTime: iso(ageMs),
      containerStatuses: [
        {
          name: "main",
          image,
          imageID: "",
          ready: true,
          restartCount: 0,
          state: { running: { startedAt: iso(ageMs) } },
        },
      ],
    },
  });
  const pods = [
    pod("optio-api-0", "optio-api:test", { app: "optio-api" }, 24 * HOUR),
    pod("optio-web-0", "optio-web:test", { app: "optio-web" }, 24 * HOUR),
    pod("optio-postgres-0", "postgres:16-alpine", { app: "postgres" }, 48 * HOUR),
    pod("optio-redis-0", "redis:7-alpine", { app: "redis" }, 48 * HOUR),
  ];
  const list = (kind: string, items: KubeItem[], apiVersion = "v1"): KubeList => ({
    kind,
    apiVersion,
    metadata: {},
    items,
  });
  const lists: Record<string, KubeList> = {
    "/api/v1/nodes": list("NodeList", [
      {
        metadata: { name: "test-node", uid: randomUUID(), creationTimestamp: iso(72 * HOUR) },
        status: {
          capacity: { cpu: "4", memory: "8Gi", pods: "110" },
          allocatable: { cpu: "4", memory: "8Gi", pods: "110" },
          conditions: [{ type: "Ready", status: "True", lastTransitionTime: iso(72 * HOUR) }],
          nodeInfo: {
            kubeletVersion: "v1.34.0",
            osImage: "fake",
            architecture: "arm64",
            containerRuntimeVersion: "fake://1",
            kernelVersion: "fake",
            operatingSystem: "linux",
            kubeProxyVersion: "v1.34.0",
            machineID: "",
            systemUUID: "",
            bootID: "",
          },
        },
      },
    ]),
    [`/api/v1/namespaces/${NAMESPACE}/pods`]: list("PodList", pods),
    [`/api/v1/namespaces/${NAMESPACE}/services`]: list("ServiceList", []),
    [`/api/v1/namespaces/${NAMESPACE}/events`]: list("EventList", []),
    "/apis/metrics.k8s.io/v1beta1/nodes": list(
      "NodeMetricsList",
      [
        {
          metadata: { name: "test-node" },
          timestamp: iso(0),
          window: "20s",
          usage: { cpu: "500000000n", memory: "2Gi" },
        },
      ],
      "metrics.k8s.io/v1beta1",
    ),
    [`/apis/metrics.k8s.io/v1beta1/namespaces/${NAMESPACE}/pods`]: list(
      "PodMetricsList",
      pods.map((p) => ({
        metadata: { name: p.metadata.name, namespace: NAMESPACE },
        timestamp: iso(0),
        window: "20s",
        containers: [{ name: "main", usage: { cpu: "10000000n", memory: "64Mi" } }],
      })),
      "metrics.k8s.io/v1beta1",
    ),
  };
  return { pods, lists };
}

async function startFakeKube(): Promise<{ url: string; close: () => Promise<void> }> {
  const { pods, lists } = clusterFixture();
  const status = (code: number, message: string) => ({
    kind: "Status",
    apiVersion: "v1",
    metadata: {},
    status: "Failure",
    message,
    reason: code === 403 ? "Forbidden" : "NotFound",
    code,
  });
  const matches = (labels: Record<string, string>, selector: string) =>
    selector.split(",").every((term) => {
      const [k, v] = term.split("=");
      return v === undefined ? k in labels : labels[k] === v;
    });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake-kube");
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method !== "GET") {
      return send(403, status(403, "the test Kubernetes API is read-only"));
    }
    const body = lists[url.pathname];
    const selector = url.searchParams.get("labelSelector");
    if (body) {
      const items = selector
        ? body.items.filter((it) => matches(it.metadata.labels ?? {}, selector))
        : body.items;
      return send(200, { ...body, items });
    }
    const podName = url.pathname.match(/^\/api\/v1\/namespaces\/[^/]+\/pods\/([^/]+)$/)?.[1];
    const found = podName && pods.find((p) => p.metadata.name === podName);
    if (found) return send(200, { kind: "Pod", apiVersion: "v1", ...found });
    send(404, status(404, `${url.pathname} not found in the test Kubernetes API`));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake kube: no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections(); // don't wait out keep-alive sockets
      }),
  };
}

function kubeconfigFor(server: string): string {
  return `apiVersion: v1
kind: Config
clusters:
  - name: optio-test
    cluster:
      server: ${server}
      # @kubernetes/client-node refuses a plain-http server without this.
      insecure-skip-tls-verify: true
contexts:
  - name: optio-test
    context:
      cluster: optio-test
      namespace: ${NAMESPACE}
      user: nobody
current-context: optio-test
users:
  - name: nobody
    user:
      token: fake
`;
}

/**
 * `env` with the stubs first on PATH, whatever PATH it ended up with (callers
 * that add their own shims pass a PATH of their own).
 */
export function withStubsFirst(
  env: Record<string, string | undefined>,
  hermetic: HermeticEnv,
): Record<string, string | undefined> {
  const path = env.PATH ?? "";
  if (path.split(":")[0] === hermetic.binDir) return env;
  return { ...env, PATH: path ? `${hermetic.binDir}:${path}` : hermetic.binDir };
}

export async function createHermeticEnv(): Promise<HermeticEnv> {
  const dir = mkdtempSync(join(tmpdir(), "optio-test-api-"));
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const claudeConfig = join(dir, "claude-config");
  for (const d of [bin, home, claudeConfig]) mkdirSync(d, { recursive: true });

  const stub = (name: string, body: string) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub("kubectl", 'echo "kubectl is disabled for test API servers (no real cluster)" >&2\nexit 1');
  stub("helm", 'echo "helm is disabled for test API servers (no real cluster)" >&2\nexit 1');
  // 44 = errSecItemNotFound: this machine's Claude login "doesn't exist".
  stub("security", "exit 44");

  const kube = await startFakeKube();
  const kubeconfig = join(dir, "kubeconfig.yaml");
  writeFileSync(kubeconfig, kubeconfigFor(kube.url));

  return {
    env: {
      PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      KUBECONFIG: kubeconfig,
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeConfig,
    },
    binDir: bin,
    kubeUrl: kube.url,
    stop: async () => {
      await kube.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
