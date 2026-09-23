/**
 * Private Optio API for Android development and tests: the API-only sibling of
 * apps/web/e2e/launch-stack.ts. It starts the test Postgres/Redis containers, clones a private
 * database from the migrated template, runs the REAL API server with the fake container runtime
 * (no pods, no LLM calls) and auth disabled, seeds data for every Android screen, and writes the
 * seeded ids to <run-dir>/seed.json. Then it stays in the foreground holding the API. SIGTERM
 * stops the API and drops the private database.
 *
 * Start it with apps/android/scripts/test-api.sh, which backgrounds it and waits for `ready`:
 *   tsx apps/android/e2e/launch-api.ts [--port 4961] [--auth] [--fcm-fake] [--run-dir DIR] [--no-seed] [--log-level warn]
 *
 * --fcm-fake runs the API with OPTIO_FCM_TRANSPORT=fake and OPTIO_FCM_FAKE_OUTBOX=<run-dir>/fcm-outbox.jsonl:
 * Android push (docs/android-push.md) is "configured", and every FCM HTTP v1 request the server
 * would send is appended to that file as one JSON line instead (nothing leaves the machine).
 *
 * --auth runs the API with authentication ENABLED: it first creates real users (admin, member,
 * viewer, and one outside the workspace), a workspace and personal access tokens, then seeds
 * everything through the admin's PAT and records the tokens in seed.json (`auth`). Default port
 * with --auth is 4980.
 *
 * It runs on the same Mac as the user's real Optio, so it is hermetic on purpose:
 *  - it listens on 127.0.0.1 only; an emulator reaches it at http://10.0.2.2:<port>;
 *  - KUBECONFIG points at a fake, read-only Kubernetes API served by this launcher (so the
 *    cluster screens have a node, pods, events and metrics) and `kubectl` / `helm` on its PATH
 *    are stubs, so the cluster routes, shared directories and repo PVC code never reach the
 *    user's real cluster;
 *  - a `security` stub and an empty CLAUDE_CONFIG_DIR hide this machine's Claude login, so the
 *    API never validates, stores or serves the user's real token;
 *  - credential env vars (GITHUB_TOKEN, ANTHROPIC_API_KEY, ...) and OPTIO_* settings from the
 *    caller's shell are not inherited.
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import buildTestInfra from "../../api/src/test-utils/integration/global-setup.js";
import { provisionRunInfra, type RunInfra } from "../../api/src/test-utils/provision.js";
import { startApiServer, type ApiServerHandle } from "../../api/src/test-utils/e2e/api-server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");

interface Args {
  port: number;
  runDir: string;
  seed: boolean;
  auth: boolean;
  fcmFake: boolean;
  logLevel: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    port: 0,
    runDir: "",
    seed: true,
    auth: false,
    fcmFake: false,
    logLevel: "warn",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--port") args.port = Number(argv[++i]);
    else if (a === "--run-dir") args.runDir = resolve(argv[++i]);
    else if (a === "--no-seed") args.seed = false;
    else if (a === "--auth") args.auth = true;
    else if (a === "--fcm-fake") args.fcmFake = true;
    else if (a === "--log-level") args.logLevel = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  args.port ||= args.auth ? 4980 : 4961;
  if (!Number.isInteger(args.port) || args.port < 1024 || args.port > 65535) {
    throw new Error(`invalid --port ${args.port}`);
  }
  if ([4931, 3131, 30400, 30310].includes(args.port)) {
    throw new Error(`port ${args.port} is reserved (web e2e or the real Optio server)`);
  }
  args.runDir ||= join(HERE, ".run", String(args.port));
  return args;
}

const ARGS = parseArgs(process.argv.slice(2));
const API_URL = `http://127.0.0.1:${ARGS.port}`;
const EMULATOR_API_URL = `http://10.0.2.2:${ARGS.port}`;
const log = (msg: string) => console.warn(`[android-api] ${msg}`);

// ---------------------------------------------------------------------------------------------
// Run-dir state: server.json (lifecycle, read by test-api.sh) and api.pid.

const serverState: Record<string, unknown> = {
  phase: "starting",
  port: ARGS.port,
  baseUrl: API_URL,
  emulatorBaseUrl: EMULATOR_API_URL,
  pid: process.pid,
  auth: ARGS.auth,
  repoRoot: REPO_ROOT,
  startedAt: new Date().toISOString(),
};

function writeJsonAtomic(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
}

function setState(patch: Record<string, unknown>): void {
  Object.assign(serverState, patch);
  writeJsonAtomic(join(ARGS.runDir, "server.json"), serverState);
}

// ---------------------------------------------------------------------------------------------
// Auth-enabled mode (--auth). Principals are created in the private database before the API
// boots, like the API's own auth e2e test (apps/api/e2e/rbac.e2e.test.ts), but through the API's
// services: users are upserted exactly as an OAuth login upserts them (createSession), the
// workspaces and memberships come from workspace-service, and the personal access tokens from
// api-key-service (`optio_pat_…`, stored as the SHA-256 hash the auth plugin looks up).

type Role = "admin" | "member" | "viewer";

interface Principal {
  id: string;
  email: string;
  displayName: string;
  username: string;
  /** Role in the main workspace; null for the user who is in no workspace yet. */
  role: Role | null;
}

interface TokenPrincipal extends Principal {
  token: string;
  tokenId: string;
}

interface AuthContext {
  workspace: { id: string; slug: string; name: string };
  secondWorkspace: { id: string; slug: string; name: string };
  admin: TokenPrincipal;
  member: TokenPrincipal;
  viewer: TokenPrincipal;
  outsider: Principal;
}

let AUTH: AuthContext | null = null;

/** The token seed requests and sockets authenticate with: the admin's PAT, or any string. */
function seedToken(): string {
  return AUTH?.admin.token ?? "dev";
}

/** Bearer + workspace headers for a seed request (none when auth is disabled). */
function authHeaders(token?: string): Record<string, string> {
  if (!AUTH) return {};
  return {
    authorization: `Bearer ${token ?? AUTH.admin.token}`,
    "x-workspace-id": AUTH.workspace.id,
  };
}

/** WebSocket subprotocols carrying a token, as every Optio client sends them. */
function wsProtocols(token = seedToken()): string[] {
  return ["optio-ws-v1", `optio-auth-${token}`];
}

async function createPrincipals(): Promise<AuthContext> {
  // The API's own services, imported only now: their DB client binds to DATABASE_URL on import.
  const { createSession } = await import("../../api/src/services/session-service.js");
  const { createWorkspace, addMember, switchWorkspace } =
    await import("../../api/src/services/workspace-service.js");
  const { createApiKey } = await import("../../api/src/services/api-key-service.js");
  const { db } = await import("../../api/src/db/client.js");
  try {
    const person = async (
      handle: string,
      displayName: string,
      role: Role | null,
    ): Promise<Principal> => {
      const { user } = await createSession("github", {
        externalId: `devlab-${handle}`,
        email: `${handle}@example.com`,
        displayName,
        username: handle,
      });
      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        username: handle,
        role,
      };
    };
    const admin = await person("ada-admin", "Ada Admin", "admin");
    const member = await person("mia-member", "Mia Member", "member");
    const viewer = await person("vic-viewer", "Vic Viewer", "viewer");
    // Exists (can be looked up by email and invited) but belongs to no workspace.
    const outsider = await person("noor-newcomer", "Noor Newcomer", null);

    // The creator becomes admin and, having no default yet, lands in the first workspace.
    const main = await createWorkspace(
      { name: "Android DevLab", slug: "android-devlab", description: "Seeded by apps/android/e2e" },
      admin.id,
    );
    const side = await createWorkspace(
      {
        name: "Side project",
        slug: "side-project",
        description: "A second workspace to switch to",
      },
      admin.id,
    );
    for (const p of [member, viewer]) {
      await addMember(main.id, p.id, p.role as Role);
      await switchWorkspace(p.id, main.id);
    }
    const withToken = async (p: Principal): Promise<TokenPrincipal> => {
      const key = await createApiKey(p.id, `Android dev lab (${p.role})`);
      return { ...p, token: key.token, tokenId: key.tokenId };
    };
    return {
      workspace: { id: main.id, slug: main.slug, name: main.name },
      secondWorkspace: { id: side.id, slug: side.slug, name: side.name },
      admin: await withToken(admin),
      member: await withToken(member),
      viewer: await withToken(viewer),
      outsider,
    };
  } finally {
    // Everything after this goes over HTTP: release this process's connection pool.
    const client = (db as unknown as { $client?: { end(o?: { timeout?: number }): Promise<void> } })
      .$client;
    await client?.end({ timeout: 5 }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Hermetic environment for the API process (see the header).

function kubeconfigFor(server: string): string {
  return `apiVersion: v1
kind: Config
clusters:
  - name: android-test-api
    cluster:
      server: ${server}
      insecure-skip-tls-verify: true
contexts:
  - name: android-test-api
    context:
      cluster: android-test-api
      namespace: optio
      user: nobody
current-context: android-test-api
users:
  - name: nobody
    user:
      token: fake
`;
}

/**
 * A tiny read-only Kubernetes API for the cluster screens: one node, Optio's control-plane and
 * repo pods, services, events and metrics, all made up. KUBECONFIG points here, so the API never
 * reaches a real cluster. Writes answer 403 Forbidden.
 */
async function startFakeKube(): Promise<string> {
  const now = Date.now();
  const iso = (agoMs: number) => new Date(now - agoMs).toISOString();
  const DAY = 24 * 3600 * 1000;
  const status = (code: number, message: string) => ({
    kind: "Status",
    apiVersion: "v1",
    metadata: {},
    status: "Failure",
    message,
    reason: code === 403 ? "Forbidden" : "NotFound",
    code,
  });
  const pod = (
    name: string,
    image: string,
    labels: Record<string, string>,
    o: { ageMs: number; ip: string; restarts?: number; crashLoop?: boolean },
  ) => ({
    metadata: {
      name,
      namespace: "optio",
      uid: randomUUID(),
      creationTimestamp: iso(o.ageMs),
      labels,
    },
    spec: { nodeName: "docker-desktop", containers: [{ name: "main", image }] },
    status: {
      phase: "Running",
      podIP: o.ip,
      startTime: iso(o.ageMs),
      containerStatuses: [
        {
          name: "main",
          image,
          imageID: "",
          ready: !o.crashLoop,
          restartCount: o.restarts ?? 0,
          state: o.crashLoop
            ? { waiting: { reason: "CrashLoopBackOff", message: "back-off 2m40s restarting" } }
            : { running: { startedAt: iso(o.ageMs) } },
        },
      ],
    },
  });
  const pods = [
    pod(
      "optio-api-6d9f7c8b5-x2k4p",
      "optio-api:latest",
      { app: "optio-api" },
      { ageMs: 3 * DAY, ip: "10.1.0.12" },
    ),
    pod(
      "optio-web-5c7d9b6f4-q8m2n",
      "optio-web:latest",
      { app: "optio-web" },
      { ageMs: 3 * DAY, ip: "10.1.0.13" },
    ),
    pod(
      "optio-postgres-0",
      "postgres:16-alpine",
      { app: "postgres" },
      { ageMs: 9 * DAY, ip: "10.1.0.5" },
    ),
    pod("optio-redis-0", "redis:7-alpine", { app: "redis" }, { ageMs: 9 * DAY, ip: "10.1.0.6" }),
    pod(
      "optio-repo-e2e-repo-0",
      "optio-agent-node:latest",
      { "managed-by": "optio", "optio.repo": "e2e-org-e2e-repo" },
      { ageMs: 2 * 3600 * 1000, ip: "10.1.0.31" },
    ),
    pod(
      "optio-repo-mobile-app-0",
      "optio-agent-node:latest",
      { "managed-by": "optio", "optio.repo": "e2e-org-mobile-app" },
      { ageMs: 40 * 60 * 1000, ip: "10.1.0.32", restarts: 4, crashLoop: true },
    ),
  ];
  const service = (name: string, port: number, ip: string) => ({
    metadata: { name, namespace: "optio", uid: randomUUID(), creationTimestamp: iso(9 * DAY) },
    spec: {
      type: "ClusterIP",
      clusterIP: ip,
      ports: [{ port, targetPort: port, protocol: "TCP" }],
    },
  });
  const event = (
    type: string,
    reason: string,
    message: string,
    object: string,
    agoMs: number,
    count = 1,
  ) => ({
    metadata: {
      name: `${object}.${randomUUID().slice(0, 8)}`,
      namespace: "optio",
      creationTimestamp: iso(agoMs),
    },
    type,
    reason,
    message,
    count,
    involvedObject: { kind: "Pod", name: object, namespace: "optio" },
    lastTimestamp: iso(agoMs),
  });
  const lists: Record<string, unknown> = {
    "/api/v1/nodes": {
      kind: "NodeList",
      apiVersion: "v1",
      metadata: {},
      items: [
        {
          metadata: {
            name: "docker-desktop",
            uid: randomUUID(),
            creationTimestamp: iso(30 * DAY),
            labels: { "kubernetes.io/arch": "arm64" },
          },
          status: {
            capacity: { cpu: "10", memory: "32873152Ki", pods: "110" },
            allocatable: { cpu: "10", memory: "32770752Ki", pods: "110" },
            conditions: [
              {
                type: "Ready",
                status: "True",
                reason: "KubeletReady",
                lastTransitionTime: iso(30 * DAY),
              },
            ],
            nodeInfo: {
              kubeletVersion: "v1.34.1",
              osImage: "Docker Desktop",
              architecture: "arm64",
              containerRuntimeVersion: "docker://29.8.0",
              kernelVersion: "6.12.54-linuxkit",
              operatingSystem: "linux",
              kubeProxyVersion: "v1.34.1",
              machineID: "",
              systemUUID: "",
              bootID: "",
            },
          },
        },
      ],
    },
    "/api/v1/namespaces/optio/pods": {
      kind: "PodList",
      apiVersion: "v1",
      metadata: {},
      items: pods,
    },
    "/api/v1/namespaces/optio/services": {
      kind: "ServiceList",
      apiVersion: "v1",
      metadata: {},
      items: [
        service("optio-api", 4000, "10.96.12.34"),
        service("optio-web", 3000, "10.96.12.35"),
        service("optio-postgres", 5432, "10.96.12.36"),
        service("optio-redis", 6379, "10.96.12.37"),
      ],
    },
    "/api/v1/namespaces/optio/events": {
      kind: "EventList",
      apiVersion: "v1",
      metadata: {},
      items: [
        event(
          "Normal",
          "Pulled",
          'Container image "optio-agent-node:latest" already present on machine',
          "optio-repo-e2e-repo-0",
          2 * 3600 * 1000,
        ),
        event(
          "Normal",
          "Started",
          "Started container main",
          "optio-repo-e2e-repo-0",
          2 * 3600 * 1000,
        ),
        event(
          "Warning",
          "BackOff",
          "Back-off restarting failed container main",
          "optio-repo-mobile-app-0",
          3 * 60 * 1000,
          4,
        ),
      ],
    },
    "/apis/metrics.k8s.io/v1beta1/nodes": {
      kind: "NodeMetricsList",
      apiVersion: "metrics.k8s.io/v1beta1",
      metadata: {},
      items: [
        {
          metadata: { name: "docker-desktop" },
          timestamp: iso(0),
          window: "20s",
          usage: { cpu: "2310000000n", memory: "9215432Ki" },
        },
      ],
    },
    "/apis/metrics.k8s.io/v1beta1/namespaces/optio/pods": {
      kind: "PodMetricsList",
      apiVersion: "metrics.k8s.io/v1beta1",
      metadata: {},
      items: pods.map((p, i) => ({
        metadata: { name: p.metadata.name, namespace: "optio" },
        timestamp: iso(0),
        window: "20s",
        containers: [
          {
            name: "main",
            usage: { cpu: `${(i + 1) * 23_000_000}n`, memory: `${(i + 2) * 61_440}Ki` },
          },
        ],
      })),
    },
  };
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
    if (req.method !== "GET")
      return send(403, status(403, "the Android test API's cluster is read-only"));
    let body = lists[url.pathname] as
      | { items?: Array<{ metadata: { labels?: Record<string, string> } }> }
      | undefined;
    const selector = url.searchParams.get("labelSelector");
    if (body?.items && selector) {
      body = {
        ...body,
        items: body.items.filter((it) => matches(it.metadata.labels ?? {}, selector)),
      };
    }
    if (body) return send(200, body);
    const podName = url.pathname.match(/^\/api\/v1\/namespaces\/optio\/pods\/([^/]+)$/)?.[1];
    const one = podName && pods.find((p) => p.metadata.name === podName);
    if (one) return send(200, { kind: "Pod", apiVersion: "v1", ...one });
    send(404, status(404, `${url.pathname} not found`));
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  server.unref();
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake kube: no address");
  return `http://127.0.0.1:${address.port}`;
}

/** Credentials and settings a developer's shell may carry that must not reach the test API. */
const STRIPPED_ENV = [
  /^OPTIO_(?!TEST_)/,
  /^(GITHUB|GH|GITLAB|LINEAR|SLACK|SENTRY|NOTION|OIDC)_/,
  /^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|CURSOR|OPENCODE)_/,
  /^CLAUDE_CODE_OAUTH_TOKEN$/,
  /^AWS_/,
  /^(DATABASE_URL|REDIS_URL|KUBECONFIG)$/,
];

function hermeticEnv(kubeServer: string): Record<string, string> {
  for (const key of Object.keys(process.env)) {
    if (STRIPPED_ENV.some((re) => re.test(key))) delete process.env[key];
  }
  const binDir = join(ARGS.runDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const stub = (name: string, body: string) => {
    const path = join(binDir, name);
    writeFileSync(path, `#!/bin/sh\n${body}\n`);
    chmodSync(path, 0o755);
  };
  stub(
    "kubectl",
    'echo "kubectl is disabled in the Android test API (no real cluster)" >&2\nexit 1',
  );
  stub("helm", 'echo "helm is disabled in the Android test API (no real cluster)" >&2\nexit 1');
  // 44 = errSecItemNotFound: the machine's Claude login "does not exist" for the test API.
  stub("security", "exit 44");
  const kubeconfig = join(ARGS.runDir, "kubeconfig.yaml");
  writeFileSync(kubeconfig, kubeconfigFor(kubeServer));
  const claudeConfigDir = join(ARGS.runDir, "claude-config");
  mkdirSync(claudeConfigDir, { recursive: true });
  return {
    PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    KUBECONFIG: kubeconfig,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}

// ---------------------------------------------------------------------------------------------
// Recorded Local sessions: a scripted daemon on /ws/local/daemon (the real protocol, see
// docs/optio-local.md) plays finished sessions on a seeded host, so every instance has an agent
// session with a transcript, a recorded screen, usage and a PR link, without a daemon or an
// LLM call. It disconnects afterwards and the host shows offline, like a laptop gone to sleep.

type DaemonFrame = Record<string, unknown> & { type: string };

class ScriptedDaemon {
  private ws!: WebSocket;
  private spawns: DaemonFrame[] = [];
  private waiters: Array<(f: DaemonFrame) => void> = [];
  private pongs = 0;

  async connect(hostId: string, dirs: Array<{ path: string; repoUrl?: string }>): Promise<void> {
    this.ws = new WebSocket(`ws://127.0.0.1:${ARGS.port}/ws/local/daemon`, wsProtocols());
    this.ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const frame = JSON.parse(ev.data) as DaemonFrame;
      if (frame.type === "pong") this.pongs += 1;
      if (frame.type !== "spawn") return;
      const waiter = this.waiters.shift();
      if (waiter) waiter(frame);
      else this.spawns.push(frame);
    });
    await new Promise<void>((resolveOpen, reject) => {
      this.ws.addEventListener("open", () => resolveOpen(), { once: true });
      this.ws.addEventListener("error", () => reject(new Error("daemon socket error")), {
        once: true,
      });
    });
    // With auth enabled the server attaches its message listener only after the PAT lookup, so
    // a hello sent right on `open` is usually dropped (then 4408 "Expected hello" after 10 s).
    // Confirm it: the server answers `ping` with `pong` only once a hello was accepted, and
    // ignores a duplicate hello, so re-send until a pong comes back.
    const hello = {
      type: "hello",
      hostId,
      daemonVersion: "0.1.0-devlab-playback",
      dirs,
      terminals: [],
      claudeCredentials: false,
    };
    for (let attempt = 0; attempt < 20 && this.pongs === 0; attempt++) {
      this.send(hello);
      this.send({ type: "ping" });
      const deadline = Date.now() + 500;
      while (this.pongs === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    if (this.pongs === 0) throw new Error("the daemon hello was never accepted");
  }

  send(frame: DaemonFrame): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** The next `spawn` the server sends (terminal id, grid, spec). */
  nextSpawn(timeoutMs = 15_000): Promise<DaemonFrame> {
    const queued = this.spawns.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolveSpawn, reject) => {
      const timer = setTimeout(() => reject(new Error("no spawn frame arrived")), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(timer);
        resolveSpawn(f);
      });
    });
  }

  close(): void {
    this.ws.close(1000, "playback done");
  }
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

/** The final screen of the recorded agent session (ANSI, CRLF), replayed by the Screen face. */
function agentScreen(prUrl: string): string {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  const lines = [
    `\x1b[38;5;99m✻\x1b[0m \x1b[1mClaude Code\x1b[0m ${dim("· headless · ~/repos/e2e-repo")}`,
    "",
    `\x1b[1m>\x1b[0m Fix the flaky date-formatting test and open a PR`,
    "",
    `\x1b[32m⏺\x1b[0m I'll look at the test first.`,
    "",
    `\x1b[32m⏺\x1b[0m \x1b[1mRead\x1b[0m(src/format-date.test.ts)`,
    `  ⎿  Read 48 lines`,
    `\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[0m(npm test -- format-date)`,
    `  ⎿  \x1b[31m✗ formats midnight in the local zone\x1b[0m`,
    `     Expected "00:00", received "24:00"`,
    `\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[0m(src/format-date.ts)`,
    `  ⎿  Updated with 1 addition and 1 removal`,
    `\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[0m(npm test -- format-date)`,
    `  ⎿  \x1b[32m✓ 14 passed\x1b[0m`,
    `\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[0m(gh pr create --fill)`,
    `  ⎿  ${prUrl}`,
    "",
    `\x1b[32m⏺\x1b[0m Fixed: \x1b[1mhourCycle: "h23"\x1b[0m keeps midnight at 00:00. PR: ${prUrl}`,
    "",
    dim("  $0.0184 · 2 turns · claude-haiku-4-5"),
  ];
  return "\x1b[2J\x1b[H" + lines.join("\r\n") + "\r\n";
}

function agentTranscript(prUrl: string, startedAt: number) {
  const at = (s: number) => new Date(startedAt + s * 1000).toISOString();
  const tool = (
    seq: number,
    name: string,
    id: string,
    text: string,
    detail: string,
    t: number,
  ) => ({
    seq,
    role: "assistant",
    kind: "tool_use",
    text,
    detail,
    toolName: name,
    toolUseId: id,
    at: at(t),
  });
  const result = (seq: number, id: string, text: string, t: number, isError = false) => ({
    seq,
    role: "tool",
    kind: "tool_result",
    text,
    toolUseId: id,
    isError,
    at: at(t),
  });
  return [
    {
      seq: 1,
      role: "user",
      kind: "text",
      text: "Fix the flaky date-formatting test and open a PR",
      at: at(0),
    },
    {
      seq: 2,
      role: "assistant",
      kind: "thinking",
      text: "The failure mentions midnight, so this is probably an hour-cycle issue in Intl.DateTimeFormat. Read the test before touching the formatter.",
      at: at(2),
    },
    { seq: 3, role: "assistant", kind: "text", text: "I'll look at the test first.", at: at(3) },
    tool(
      4,
      "Read",
      "toolu_01",
      "src/format-date.test.ts",
      '{"file_path":"src/format-date.test.ts"}',
      4,
    ),
    result(5, "toolu_01", "Read 48 lines", 5),
    tool(
      6,
      "Bash",
      "toolu_02",
      "npm test -- format-date",
      '{"command":"npm test -- format-date"}',
      7,
    ),
    result(
      7,
      "toolu_02",
      '✗ formats midnight in the local zone\n  Expected "00:00", received "24:00"',
      12,
      true,
    ),
    tool(
      8,
      "Edit",
      "toolu_03",
      "src/format-date.ts",
      '{"file_path":"src/format-date.ts","old_string":"hour12: false","new_string":"hourCycle: \\"h23\\""}',
      15,
    ),
    result(9, "toolu_03", "Updated src/format-date.ts with 1 addition and 1 removal", 16),
    tool(
      10,
      "Bash",
      "toolu_04",
      "npm test -- format-date",
      '{"command":"npm test -- format-date"}',
      18,
    ),
    result(11, "toolu_04", "✓ 14 passed", 23),
    tool(12, "Bash", "toolu_05", "gh pr create --fill", '{"command":"gh pr create --fill"}', 25),
    result(13, "toolu_05", prUrl, 29),
    {
      seq: 14,
      role: "assistant",
      kind: "text",
      text: [
        "## Fixed the flaky test",
        "",
        "`hour12: false` lets some locales render midnight as **24:00**. The formatter now uses",
        '`hourCycle: "h23"`, so midnight is always `00:00`:',
        "",
        "```ts",
        'new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })',
        "```",
        "",
        "- `npm test -- format-date`: 14 passed",
        `- PR: ${prUrl}`,
      ].join("\n"),
      at: at(31),
    },
  ];
}

/** A failed build command's final screen (a non-agent session: Screen face only). */
function commandScreen(): string {
  return (
    "\x1b[2J\x1b[H$ npm run build\r\n\r\n> e2e-repo@1.0.0 build\r\n> tsc -p .\r\n\r\n" +
    "\x1b[31msrc/api.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.\x1b[0m\r\n" +
    "\r\nFound 1 error in src/api.ts\x1b[2m:12\x1b[0m\r\n"
  );
}

// ---------------------------------------------------------------------------------------------
// API env on top of startApiServer's e2e defaults.

/** Dev-only secret so the seed can complete a task with a signed `pull_request` merged event. */
const DEV_GITHUB_WEBHOOK_SECRET = "android-devlab-github-webhook-secret";

const ONE_YEAR_MS = String(365 * 24 * 3600 * 1000);

const API_ENV_OVERRIDES: Record<string, string> = {
  // Seeded "running" work hangs on purpose ([[mock:hang]]): never fail it as stalled (reconciler)
  // or stale (repo-cleanup worker). (Rate limiting needs no override: 127.0.0.1, which is how
  // emulators and the test daemon arrive, is on the API's allow list.)
  OPTIO_STALL_THRESHOLD_MS: ONE_YEAR_MS,
  OPTIO_STALE_TASK_MS: ONE_YEAR_MS,
  GITHUB_WEBHOOK_SECRET: DEV_GITHUB_WEBHOOK_SECRET,
};

// ---------------------------------------------------------------------------------------------
// Seeding. Every step is optional except secrets + the main repo: a failing step is logged,
// recorded under `errors` in seed.json, and the rest carries on.

const SEED_REPO_URL = "https://github.com/e2e-org/e2e-repo";
const SEED_REPO_2_URL = "https://github.com/e2e-org/mobile-app";
const LAPTOP_DIRS = [
  { path: "/Users/e2e/repos/e2e-repo", repoUrl: SEED_REPO_URL },
  { path: "/Users/e2e/notes" },
];

type Json = Record<string, any>;

async function api<T = Json>(
  path: string,
  body?: unknown,
  method?: string,
  token?: string,
): Promise<T> {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const res = await fetch(`${API_URL}${path}`, {
    method: verb,
    headers: {
      ...authHeaders(token),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${verb} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

async function waitUntil<T>(
  label: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

const pick = (obj: Json | undefined, ...keys: string[]): Json =>
  Object.fromEntries(keys.filter((k) => obj?.[k] !== undefined).map((k) => [k, obj![k]]));

async function getTask(id: string): Promise<Json> {
  const body = await api(`/api/tasks/${id}`);
  return body.task ?? body;
}

async function waitTask(id: string, states: string[], timeoutMs = 90_000): Promise<Json> {
  return waitUntil(
    `task ${id} to reach ${states.join("|")}`,
    async () => {
      const task = await getTask(id);
      return states.includes(task.state) ? task : null;
    },
    timeoutMs,
  );
}

async function waitRun(id: string, states: string[], timeoutMs = 90_000): Promise<Json> {
  return waitUntil(
    `job run ${id} to reach ${states.join("|")}`,
    async () => {
      const { run } = await api(`/api/workflow-runs/${id}`);
      return states.includes(run.state) ? run : null;
    },
    timeoutMs,
  );
}

async function getTerminal(id: string): Promise<Json> {
  return (await api(`/api/local/terminals/${id}`)).terminal;
}

/** A GitHub webhook event, signed like GitHub signs it (X-Hub-Signature-256). */
async function githubEvent(event: string, payload: Json): Promise<void> {
  const body = JSON.stringify(payload);
  const signature =
    "sha256=" + createHmac("sha256", DEV_GITHUB_WEBHOOK_SECRET).update(body).digest("hex");
  const res = await fetch(`${API_URL}/api/webhooks/github`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      "x-github-event": event,
      "x-github-delivery": randomUUID(),
      "x-hub-signature-256": signature,
    },
    body,
  });
  if (!res.ok) throw new Error(`github ${event} webhook → ${res.status}: ${await res.text()}`);
}

/** One message on a pod session's chat socket; resolves once the fake agent's turn ends. */
function sessionChat(sessionId: string, content: string): Promise<void> {
  return new Promise((resolveChat, reject) => {
    const ws = new WebSocket(
      `ws://127.0.0.1:${ARGS.port}/ws/sessions/${sessionId}/chat`,
      wsProtocols(),
    );
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("no chat reply within 30s"));
    }, 30_000);
    const done = () => {
      clearTimeout(timer);
      ws.close();
      resolveChat();
    };
    let ready = false;
    let thinking = false;
    // The server sends `ready`, replays the chat history, and only then listens: a message sent
    // right after `ready` can be dropped, so send a beat later and again until it is picked up.
    const sendUntilPickedUp = (attempt: number) => {
      if (thinking || attempt > 5) return;
      ws.send(JSON.stringify({ type: "message", content }));
      setTimeout(() => sendUntilPickedUp(attempt + 1), 3000);
    };
    ws.addEventListener("message", (ev) => {
      if (typeof ev.data !== "string") return;
      const frame = JSON.parse(ev.data) as Json;
      if (!ready && frame.type === "status" && frame.status === "ready") {
        ready = true;
        setTimeout(() => sendUntilPickedUp(1), 1000);
        return;
      }
      if (frame.type === "error") {
        clearTimeout(timer);
        ws.close();
        reject(new Error(`chat error: ${frame.message}`));
      } else if (frame.type === "status" && frame.status === "thinking") {
        thinking = true;
      } else if (frame.type === "status" && frame.status === "idle" && thinking) {
        done();
      }
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("chat socket error"));
    });
  });
}

/** The manifest every run writes: API coordinates, and (with --auth) the principals. */
function baseManifest(): Json {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    api: {
      port: ARGS.port,
      baseUrl: API_URL,
      emulatorBaseUrl: EMULATOR_API_URL,
      // What a client sends: any string with auth disabled, the admin's PAT with --auth.
      token: seedToken(),
      authDisabled: !AUTH,
      githubWebhookSecret: DEV_GITHUB_WEBHOOK_SECRET,
    },
    errors: [],
    ...(AUTH ? { auth: authManifest(AUTH) } : {}),
  };
}

function authManifest(a: AuthContext): Json {
  const person = (p: Principal) => pick(p, "id", "email", "displayName", "username", "role");
  return {
    enabled: true,
    workspaceId: a.workspace.id,
    workspaceSlug: a.workspace.slug,
    workspaceName: a.workspace.name,
    secondWorkspaceId: a.secondWorkspace.id,
    adminToken: a.admin.token,
    memberToken: a.member.token,
    viewerToken: a.viewer.token,
    userIds: {
      admin: a.admin.id,
      member: a.member.id,
      viewer: a.viewer.id,
      outsider: a.outsider.id,
    },
    users: {
      admin: { ...person(a.admin), apiKeyId: a.admin.tokenId },
      member: { ...person(a.member), apiKeyId: a.member.tokenId },
      viewer: { ...person(a.viewer), apiKeyId: a.viewer.tokenId },
      outsider: person(a.outsider),
    },
  };
}

async function seed(): Promise<Json> {
  const m = baseManifest();
  const errors = m.errors as Array<{ step: string; error: string }>;
  const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      errors.push({ step: name, error });
      log(`seed step "${name}" skipped: ${error}`);
      return undefined;
    }
  };
  const mkTask = async (title: string, prompt: string, extra: Json = {}) => {
    const body = await api("/api/tasks", {
      title,
      prompt,
      repoUrl: SEED_REPO_URL,
      agentType: "claude-code",
      ...extra,
    });
    return (body.task ?? body) as Json;
  };

  // Required: the setup gate wants a git token + an agent key (dummy values; the fake runtime
  // never uses them), and repo tasks need a repo.
  await api("/api/secrets", { name: "GITHUB_TOKEN", value: "android-e2e-dummy-git-token" });
  await api("/api/secrets", { name: "ANTHROPIC_API_KEY", value: "android-e2e-dummy-agent-key" });
  m.secrets = ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"];
  const main = (await api("/api/repos", { repoUrl: SEED_REPO_URL, fullName: "e2e-org/e2e-repo" }))
    .repo as Json;
  m.repos = { main: pick(main, "id", "repoUrl", "fullName") };
  // Room for the seeded tasks to run side by side (and a non-default value to show).
  await step("repo main: settings", () =>
    api(`/api/repos/${main.id}`, { maxConcurrentTasks: 6 }, "PATCH"),
  );
  await step("repo mobile-app", async () => {
    const repo = (
      await api("/api/repos", { repoUrl: SEED_REPO_2_URL, fullName: "e2e-org/mobile-app" })
    ).repo as Json;
    m.repos.second = pick(repo, "id", "repoUrl", "fullName");
  });

  // Named library prompts, one per kind. (Plain POST /api/prompt-templates would overwrite the
  // global default coding template instead.)
  m.prompts = {};
  for (const [kind, name, description, template] of [
    [
      "prompt",
      "Explain a failing test",
      "Ask an agent to diagnose one failing test",
      "Explain why {{test}} fails and propose the smallest fix.",
    ],
    [
      "task",
      "Add a feature flag",
      "Repo task: wire a new flag end to end",
      "Add a feature flag named {{flag}}{{#if owner}} owned by {{owner}}{{/if}}, default off, and open a PR.",
    ],
    [
      "job",
      "Weekly dependency report",
      "Standalone job: summarize outdated dependencies",
      "List outdated dependencies in {{repo}} and summarize the risk of each upgrade.",
    ],
    [
      "review",
      "Strict code review",
      "Reviewer instructions that flag blockers first",
      "Review the PR for correctness, tests and naming. Be concise; flag blockers first.",
    ],
  ] as const) {
    await step(`prompt (${kind})`, async () => {
      const { template: saved } = await api("/api/prompt-templates/named", {
        name,
        kind,
        description,
        template,
      });
      m.prompts[kind] = pick(saved, "id", "name", "kind");
    });
  }

  // Repo tasks in a spread of states.
  m.tasks = {};
  await step("tasks: pr_opened / completed / failed / needs_attention", async () => {
    const pr = await mkTask(
      "Add a dark mode toggle to Settings",
      "Add a dark mode toggle to the Settings screen. [[mock:pr]] [[mock:cost:0.4213]]",
    );
    const merged = await mkTask(
      "Paginate the activity feed",
      "Paginate the activity feed endpoint and list. [[mock:pr]] [[mock:cost:0.8764]]",
    );
    const failed = await mkTask(
      "Upgrade the payments SDK",
      "Upgrade the payments SDK to v5. [[mock:fail]] [[mock:cost:0.0310]]",
      { maxRetries: 0 },
    );
    const attention = await mkTask(
      "Tidy up the config loader",
      "Tidy up the config loader; no PR needed. [[mock:cost:0.0931]]",
    );
    const settled = await Promise.all([
      waitTask(pr.id, ["pr_opened"]),
      waitTask(merged.id, ["pr_opened"]),
      waitTask(failed.id, ["failed"]),
      waitTask(attention.id, ["needs_attention"]),
    ]);
    const [prDone, mergedOpen, failedDone, attentionDone] = settled;
    m.tasks.prOpened = pick(prDone, "id", "title", "state", "prUrl");
    m.tasks.failed = pick(failedDone, "id", "title", "state");
    m.tasks.needsAttention = pick(attentionDone, "id", "title", "state");
    // A merged PR completes its task (the same signed webhook GitHub would send).
    const prNumber = Number(String(mergedOpen.prUrl).split("/").pop());
    await githubEvent("pull_request", {
      action: "closed",
      number: prNumber,
      pull_request: {
        number: prNumber,
        html_url: mergedOpen.prUrl,
        title: mergedOpen.title,
        state: "closed",
        merged: true,
        user: { login: "e2e-dev" },
      },
      repository: { full_name: "e2e-org/e2e-repo", html_url: SEED_REPO_URL },
      sender: { login: "e2e-dev" },
    });
    m.tasks.completed = pick(
      await waitTask(merged.id, ["completed"]),
      "id",
      "title",
      "state",
      "prUrl",
    );
  });

  await step("task: running (hangs)", async () => {
    const running = await mkTask(
      "Migrate the image cache to Coil 3",
      "Migrate the image cache to Coil 3. [[mock:hang]]",
      { repoUrl: SEED_REPO_2_URL, maxRetries: 0 },
    );
    m.tasks.running = pick(await waitTask(running.id, ["running"]), "id", "title", "state");
  });

  await step("task: cancelled", async () => {
    const task = await mkTask(
      "Refactor analytics events",
      "Refactor the analytics event names. [[mock:sleep:600000]]",
      { maxRetries: 0 },
    );
    await waitTask(task.id, ["running"]);
    await api(`/api/tasks/${task.id}/cancel`, {});
    m.tasks.cancelled = pick(await waitTask(task.id, ["cancelled"]), "id", "title", "state");
  });

  if (m.tasks.needsAttention) {
    // Dependencies count as met only at completed / pr_opened, so this one waits.
    await step("task: waiting on a dependency", async () => {
      const task = await mkTask(
        "Document the config loader cleanup",
        "Write the upgrade notes for the config loader cleanup.",
        { dependsOn: [m.tasks.needsAttention.id] },
      );
      m.tasks.waitingOnDeps = pick(
        await waitTask(task.id, ["waiting_on_deps"]),
        "id",
        "title",
        "state",
      );
    });
  }

  if (m.tasks.prOpened) {
    await step("task comment", async () => {
      const body = await api(`/api/tasks/${m.tasks.prOpened.id}/comments`, {
        content: "Looks good on a Pixel 9. Can we also cover the high-contrast theme?",
      });
      m.tasks.prOpened.commentId = (body.comment ?? body).id;
    });
    await step("review subtask", async () => {
      const { reviewTaskId } = await api(`/api/tasks/${m.tasks.prOpened.id}/review`, {});
      m.tasks.review = pick(
        await waitTask(reviewTaskId, ["completed", "failed"]),
        "id",
        "title",
        "state",
      );
    });
  }

  // A Job (standalone) with completed, failed and running runs; params fill {{mode}}.
  await step("job with runs", async () => {
    const { workflow } = await api("/api/jobs", {
      name: "Nightly release notes",
      description: "Drafts release notes from yesterday's merged PRs",
      promptTemplate: "Draft release notes for everything merged yesterday. {{mode}}",
      agentRuntime: "claude-code",
      maxRetries: 0,
    });
    const run = async (mode: string) =>
      (await api(`/api/jobs/${workflow.id}/runs`, { params: { mode } })).run as Json;
    const ok = await run("[[mock:cost:0.0520]]");
    const completed = await waitRun(ok.id, ["completed"]);
    const bad = await run("[[mock:fail]]");
    const failed = await waitRun(bad.id, ["failed"]);
    const live = await run("[[mock:hang]]");
    const running = await waitRun(live.id, ["running"]);
    m.jobs = {
      main: {
        ...pick(workflow, "id", "name"),
        runs: {
          completed: completed.id,
          failed: failed.id,
          running: running.id,
        },
      },
    };
  });

  await step("job with webhook trigger", async () => {
    const { workflow } = await api("/api/jobs", {
      name: "Triage Sentry alerts",
      promptTemplate: "Triage this Sentry alert and suggest an owner: {{title}} ({{url}})",
      agentRuntime: "claude-code",
    });
    const path = `android-e2e-sentry-${ARGS.port}`;
    const { trigger } = await api(`/api/jobs/${workflow.id}/triggers`, {
      type: "webhook",
      config: { path },
    });
    const { runId } = await api(`/api/hooks/${path}`, {
      title: "TypeError: cannot read 'amount' of undefined in checkout",
      url: "https://sentry.example.invalid/issues/4242",
    });
    const run = await waitRun(runId, ["completed", "failed"]);
    m.jobs = m.jobs ?? {};
    m.jobs.webhook = {
      ...pick(workflow, "id", "name"),
      triggerId: trigger.id,
      webhookPath: path,
      hookUrl: `${EMULATOR_API_URL}/api/hooks/${path}`,
      runId: run.id,
    };
  });

  // A scheduled repo Task (task config) with a weekday cron trigger and one prior run.
  await step("scheduled task config", async () => {
    const body = await api("/api/task-configs", {
      name: "Weekly dependency bump",
      title: "Bump minor dependency versions",
      prompt: "Bump all minor dependency versions and open a PR. [[mock:pr]] [[mock:cost:0.2140]]",
      repoUrl: SEED_REPO_URL,
      agentType: "claude-code",
    });
    const config = (body.taskConfig ?? body.config ?? body) as Json;
    const { trigger } = await api(`/api/task-configs/${config.id}/triggers`, {
      type: "schedule",
      config: { cronExpression: "0 9 * * 1" },
    });
    m.scheduled = { ...pick(config, "id", "name"), triggerId: trigger.id, cron: "0 9 * * 1" };
    const { taskId } = await api(`/api/task-configs/${config.id}/run`, {});
    m.scheduled.lastRunTaskId = (await waitTask(taskId, ["pr_opened"])).id;
  });

  // Persistent agents: one woken by a user message (its reply is in the turn logs) with a daily
  // schedule, and one paused.
  m.agents = {};
  await step("persistent agent", async () => {
    const { agent } = await api("/api/persistent-agents", {
      slug: "release-captain",
      name: "Release Captain",
      description: "Coordinates releases and answers questions about what is blocking them",
      agentRuntime: "claude-code",
      initialPrompt: "You coordinate releases for e2e-org/e2e-repo. Answer questions tersely.",
    });
    m.agents.main = pick(agent, "id", "slug", "name");
    await api(`/api/persistent-agents/${agent.id}/messages`, {
      body: "What's blocking the 2.4 release?",
    });
    await waitUntil("the agent's first turns", async () => {
      const body = await api(`/api/persistent-agents/${agent.id}`);
      const { turns } = await api(`/api/persistent-agents/${agent.id}/turns`);
      return (
        body.agent.state === "idle" && (turns as unknown[]).length > 0 && body.inbox?.pending === 0
      );
    });
    const { trigger } = await api(`/api/persistent-agents/${agent.id}/triggers`, {
      type: "schedule",
      config: { cronExpression: "0 8 * * *" },
    });
    m.agents.main.triggerId = trigger.id;
  });
  await step("persistent agent (paused)", async () => {
    const { agent } = await api("/api/persistent-agents", {
      slug: "docs-gardener",
      name: "Docs Gardener",
      description: "Keeps the docs in sync with the code; paused",
      agentRuntime: "claude-code",
      podLifecycle: "on-demand",
      initialPrompt: "You keep docs/ in sync with the code. Wait for instructions.",
    });
    await waitUntil("the second agent's first turn", async () => {
      const body = await api(`/api/persistent-agents/${agent.id}`);
      return body.agent.state === "idle" && body.agent.lastTurnAt;
    });
    await api(`/api/persistent-agents/${agent.id}/control`, { intent: "pause" });
    const paused = await waitUntil("the second agent paused", async () => {
      const body = await api(`/api/persistent-agents/${agent.id}`);
      return body.agent.state === "paused" ? body.agent : null;
    });
    m.agents.paused = pick(paused, "id", "slug", "name", "state");
  });

  // Connections (database only: nothing contacts a provider), an MCP server.
  m.connections = {};
  await step("connection (filesystem)", async () => {
    const { connection } = await api("/api/connections", {
      name: "Docs filesystem",
      providerSlug: "filesystem",
      config: { ROOT_PATH: "/workspace/docs" },
    });
    await api(`/api/connections/${connection.id}/test`, {});
    m.connections.filesystem = pick(connection, "id", "name");
  });
  await step("connection (custom HTTP, assigned to the main repo)", async () => {
    const { connection } = await api("/api/connections", {
      name: "Status page API",
      providerSlug: "custom-http",
      config: { baseUrl: "https://status.example.com", authType: "none" },
    });
    const { assignment } = await api(`/api/connections/${connection.id}/assignments`, {
      repoId: main.id,
      agentTypes: ["claude-code"],
      permission: "read",
    });
    m.connections.http = { ...pick(connection, "id", "name"), assignmentId: assignment.id };
  });
  await step("MCP server", async () => {
    const { server } = await api("/api/mcp-servers", {
      name: "everything",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-everything"],
    });
    m.mcpServer = pick(server, "id", "name");
  });

  // An outbound webhook. Its host is .invalid (never resolves), so deliveries fail harmlessly
  // and the delivery history has entries.
  await step("outbound webhook", async () => {
    const { webhook } = await api("/api/webhooks", {
      url: "https://hooks.example.invalid/optio",
      events: ["task.completed", "task.failed", "workflow_run.completed"],
      description: "Posts task outcomes to the team's chat bridge",
    });
    await api(`/api/webhooks/${webhook.id}/test`, {}).catch(() => undefined);
    m.webhooks = { main: pick(webhook, "id", "url") };
  });

  // Interactive pod sessions: one active with a PR and a chat exchange, one ended.
  m.sessions = {};
  await step("pod session (active)", async () => {
    const { session } = await api("/api/sessions", {
      repoUrl: SEED_REPO_URL,
      title: "Investigate slow cold start",
    });
    m.sessions.active = pick(session, "id", "title", "state");
    await api(`/api/sessions/${session.id}/prs`, {
      prUrl: "https://github.com/e2e-org/e2e-repo/pull/77",
      prNumber: 77,
    });
    await step("pod session chat", async () => {
      await sessionChat(
        session.id,
        "Profile the app's cold start and list the three slowest steps.",
      );
      const { events } = await api(`/api/sessions/${session.id}/chat`);
      m.sessions.active.chatEvents = (events as unknown[]).length;
    });
  });
  await step("pod session (ended)", async () => {
    const { session } = await api("/api/sessions", {
      repoUrl: SEED_REPO_2_URL,
      title: "Try the new image loader",
    });
    const { session: ended } = await api(`/api/sessions/${session.id}/end`, {});
    m.sessions.ended = pick(ended, "id", "title", "state");
  });

  await step("Optio agent settings", async () => {
    await api("/api/optio/settings", { model: "sonnet", confirmWrites: true, maxTurns: 20 }, "PUT");
  });

  await step("local: laptop host, automation, recorded sessions", async () => {
    m.local = await seedLocal();
  });

  if (AUTH) await seedAuthExtras(m, AUTH, step);

  if (m.local?.offlineHost) {
    // A Task whose run location is the (offline) laptop: it stays queued, its terminal parked.
    await step("task: queued on the offline laptop", async () => {
      const task = await mkTask(
        "Fix the Safari date picker",
        "Fix the Safari date picker overflow and open a PR.",
        {
          runTarget: "local",
          localHostId: m.local.offlineHost.id,
          localDir: LAPTOP_DIRS[0].path,
          localSessionMode: "headless",
        },
      );
      m.tasks.queuedLocal = pick(await waitTask(task.id, ["queued"]), "id", "title", "state");
    });
  }

  return m;
}

/** Offline laptop host + automation, with sessions played by the scripted daemon. */
async function seedLocal(): Promise<Json> {
  const { host } = await api("/api/local/hosts/register", {
    name: "E2E laptop",
    hostname: "e2e-laptop",
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: LAPTOP_DIRS,
  });
  const { blueprint } = await api("/api/local/blueprints", {
    name: "Fix flaky tests",
    description: "Runs Claude Code headless on the laptop to fix a named flaky test",
    agent: "claude-code",
    commandTemplate: "Fix the flaky test {{test}} and open a PR",
    hostId: host.id,
    dir: LAPTOP_DIRS[0].path,
    sessionMode: "headless",
    spawnMode: "auto",
  });
  const out: Json = {
    offlineHost: { ...pick(host, "id", "name", "hostname"), dirs: LAPTOP_DIRS },
    automation: pick(blueprint, "id", "name"),
  };
  const { trigger } = await api(`/api/local/blueprints/${blueprint.id}/triggers`, {
    type: "schedule",
    config: { cronExpression: "0 7 * * 1-5" },
  });
  out.automation.triggerId = trigger.id;

  const daemon = new ScriptedDaemon();
  await daemon.connect(host.id, LAPTOP_DIRS);
  try {
    await waitUntil("the laptop host online", async () => {
      const { hosts } = await api("/api/local/hosts");
      return (hosts as Json[]).find((h) => h.id === host.id && h.state === "online");
    });

    // 1. The automation's headless Claude Code run: transcript, usage, PR link, final screen.
    await api(`/api/local/blueprints/${blueprint.id}/spawn`, { params: { test: "format-date" } });
    const agentSpawn = await daemon.nextSpawn();
    const agentId = String(agentSpawn.terminalId);
    const prUrl = "https://github.com/e2e-org/e2e-repo/pull/412";
    const startedAt = Date.now() - 45_000;
    daemon.send({ type: "started", terminalId: agentId });
    daemon.send({ type: "session", terminalId: agentId, agentSessionId: randomUUID() });
    daemon.send({
      type: "usage",
      terminalId: agentId,
      usage: {
        inputTokens: 18_342,
        outputTokens: 2_106,
        cacheReadTokens: 41_210,
        cacheWriteTokens: 6_402,
        turns: 2,
        model: "claude-haiku-4-5",
        costUsd: 0.0184,
        updatedAt: new Date().toISOString(),
      },
    });
    daemon.send({
      type: "transcript",
      terminalId: agentId,
      entries: agentTranscript(prUrl, startedAt),
    });
    daemon.send({
      type: "links",
      terminalId: agentId,
      links: [{ url: prUrl, kind: "pr", provider: "github", label: "e2e-org/e2e-repo#412" }],
    });
    daemon.send({
      type: "preview",
      terminalId: agentId,
      preview: `Fixed: hourCycle "h23" keeps midnight at 00:00. PR: ${prUrl}`,
      lastActivityAt: new Date().toISOString(),
    });
    daemon.send({
      type: "snapshot",
      terminalId: agentId,
      dataB64: b64(agentScreen(prUrl)),
      cols: 100,
      rows: 30,
    });
    daemon.send({ type: "exit", terminalId: agentId, exitCode: 0 });
    const agentTerminal = await waitUntil("the recorded agent session to exit", async () => {
      const t = await getTerminal(agentId);
      return t.state === "exited" ? t : null;
    });
    const transcript = await api(`/api/local/terminals/${agentId}/transcript`);

    // 2. A build command that failed: a non-agent session (Screen face only).
    const { terminal: cmd } = await api("/api/local/terminals", {
      hostId: host.id,
      dir: LAPTOP_DIRS[0].path,
      title: "npm run build",
      spec: { kind: "command", command: "npm run build" },
    });
    const cmdSpawn = await daemon.nextSpawn();
    daemon.send({ type: "started", terminalId: cmdSpawn.terminalId });
    daemon.send({
      type: "snapshot",
      terminalId: cmdSpawn.terminalId,
      dataB64: b64(commandScreen()),
      cols: 100,
      rows: 30,
    });
    daemon.send({ type: "exit", terminalId: cmdSpawn.terminalId, exitCode: 2 });
    await waitUntil("the recorded command session to exit", async () => {
      const t = await getTerminal(cmd.id);
      return t.state === "exited" ? t : null;
    });

    out.recordedAgentSession = {
      terminalId: agentId,
      title: agentTerminal.title,
      transcriptEntries: (transcript.entries as unknown[]).length,
      prUrl,
    };
    out.recordedCommandSession = { terminalId: cmd.id, title: "npm run build", exitCode: 2 };
  } finally {
    daemon.close();
  }
  await waitUntil("the laptop host offline", async () => {
    const { hosts } = await api("/api/local/hosts");
    return (hosts as Json[]).find((h) => h.id === host.id && h.state === "offline");
  });

  // 3. A shell asked for while the laptop sleeps: parked until the host reconnects.
  const { terminal: parked } = await api("/api/local/terminals", {
    hostId: host.id,
    dir: LAPTOP_DIRS[1].path,
    title: "Notes shell",
    spec: { kind: "shell" },
  });
  out.parkedTerminal = pick(parked, "id", "title", "state");
  return out;
}

// ---------------------------------------------------------------------------------------------
// Auth-enabled extras and self-checks.

type Step = <T>(name: string, fn: () => Promise<T>) => Promise<T | undefined>;

/** Data only an authenticated server has: more keys, preferences, a push device, other authors. */
async function seedAuthExtras(m: Json, a: AuthContext, step: Step): Promise<void> {
  await step("auth: a second, expiring API key for the admin", async () => {
    const expiresAt = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const key = await api("/api/auth/api-keys", { name: "Pixel 9 emulator", expiresAt });
    m.auth.users.admin.extraApiKey = { id: key.tokenId, name: key.name, expiresAt };
  });
  await step("auth: non-default notification preferences", async () => {
    await api(
      "/api/notifications/preferences",
      { "task.stalled": { push: true }, "agent.turn_completed": { push: false } },
      "PUT",
    );
  });
  // An iOS device (the only platform the API registers today). APNs is not configured on the
  // test API, so nothing is ever pushed to it.
  await step("auth: a registered iOS push device", async () => {
    const { device } = await api("/api/notifications/devices", {
      token: randomBytes(32).toString("hex"),
      platform: "ios",
      environment: "sandbox",
      bundleId: "dev.optio.ios",
      appVersion: "1.0 (devlab)",
      deviceName: "Ada's iPhone",
    });
    m.auth.pushDeviceId = device.id;
  });
  if (m.tasks?.prOpened) {
    await step("auth: a comment by the member", async () => {
      const body = await api(
        `/api/tasks/${m.tasks.prOpened.id}/comments`,
        { content: "Could you attach a screenshot of the dark theme?" },
        "POST",
        a.member.token,
      );
      m.tasks.prOpened.memberCommentId = (body.comment ?? body).id;
    });
  }
}

interface AuthCheck {
  name: string;
  ok: boolean;
  detail: string;
}

interface WsProbe {
  outcome: "message" | "open" | "closed";
  code?: number;
  reason?: string;
  first?: string;
}

/** Open a socket and report whether the server let it in: a frame, still open, or closed. */
function probeWs(path: string, protocols: string[], waitMs = 1500): Promise<WsProbe> {
  return new Promise((resolveProbe) => {
    const ws = new WebSocket(`ws://127.0.0.1:${ARGS.port}${path}`, protocols);
    let settled = false;
    const finish = (result: WsProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* already closed */
      }
      resolveProbe(result);
    };
    const timer = setTimeout(() => finish({ outcome: "open" }), waitMs);
    ws.addEventListener("message", (ev) =>
      finish({
        outcome: "message",
        first: typeof ev.data === "string" ? ev.data.slice(0, 60) : "<binary>",
      }),
    );
    ws.addEventListener("close", (ev) =>
      finish({ outcome: "closed", code: ev.code, reason: ev.reason }),
    );
    ws.addEventListener("error", () => {
      /* a close event follows */
    });
  });
}

/**
 * Proves the auth-enabled server behaves: the user-scoped routes answer the PATs, roles gate
 * writes, and sockets accept a PAT or a single-use /api/auth/ws-token token in the subprotocol.
 * HTTP checks send only the token (no x-workspace-id), as a freshly paired app does.
 */
async function runAuthChecks(m: Json, a: AuthContext): Promise<AuthCheck[]> {
  const checks: AuthCheck[] = [];
  const http = async (
    name: string,
    token: string | null,
    method: string,
    path: string,
    expect: number,
    verify?: (body: any) => string | null,
    body?: unknown,
  ) => {
    let detail = `${method} ${path} → `;
    let ok = false;
    try {
      const res = await fetch(`${API_URL}${path}`, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json().catch(() => null);
      const problem = res.status === expect && verify ? verify(json) : null;
      ok = res.status === expect && !problem;
      detail += `${res.status}${problem ? ` (${problem})` : ""}`;
    } catch (err) {
      detail += `request failed: ${err instanceof Error ? err.message : err}`;
    }
    checks.push({ name, ok, detail: `${detail} [expected ${expect}]` });
  };
  const ws = async (name: string, path: string, protocols: string[], expect: "in" | number) => {
    const r = await probeWs(path, protocols);
    const ok =
      expect === "in" ? r.outcome !== "closed" : r.outcome === "closed" && r.code === expect;
    const got =
      r.outcome === "closed"
        ? `closed ${r.code}${r.reason ? ` "${r.reason}"` : ""}`
        : r.outcome === "message"
          ? `accepted, first frame ${r.first}`
          : "accepted, still open after 1.5 s";
    checks.push({
      name,
      ok,
      detail: `WS ${path} → ${got} [expected ${expect === "in" ? "accepted" : `close ${expect}`}]`,
    });
  };
  const role = (want: Role) => (b: any) =>
    b?.user?.workspaceRole === want && b?.user?.workspaceId === a.workspace.id
      ? null
      : `workspaceRole=${b?.user?.workspaceRole} workspaceId=${b?.user?.workspaceId}`;
  const count = (key: string, min: number) => (b: any) =>
    (b?.[key]?.length ?? 0) >= min ? null : `${b?.[key]?.length ?? "no"} ${key}`;
  const lookup = `/api/users/lookup?email=${encodeURIComponent(a.outsider.email)}`;

  await http("admin: /api/auth/me", a.admin.token, "GET", "/api/auth/me", 200, role("admin"));
  await http("admin: /api/glance/watch", a.admin.token, "GET", "/api/glance/watch", 200);
  await http(
    "admin: /api/notifications/devices",
    a.admin.token,
    "GET",
    "/api/notifications/devices",
    200,
  );
  await http(
    "admin: /api/notifications/preferences",
    a.admin.token,
    "GET",
    "/api/notifications/preferences",
    200,
  );
  await http(
    "admin: /api/workspaces",
    a.admin.token,
    "GET",
    "/api/workspaces",
    200,
    count("workspaces", 2),
  );
  await http(
    "admin: workspace members",
    a.admin.token,
    "GET",
    `/api/workspaces/${a.workspace.id}/members`,
    200,
    count("members", 3),
  );
  await http(
    "admin: /api/auth/api-keys",
    a.admin.token,
    "GET",
    "/api/auth/api-keys",
    200,
    count("keys", 1),
  );
  await http("admin: /api/users/lookup", a.admin.token, "GET", lookup, 200, (b) =>
    b?.user?.id === a.outsider.id ? null : "wrong user",
  );
  await http("admin: /api/auth/ws-token", a.admin.token, "GET", "/api/auth/ws-token", 200, (b) =>
    typeof b?.token === "string" && b.token !== "auth-disabled" ? null : "no token",
  );
  await http("member: /api/auth/me", a.member.token, "GET", "/api/auth/me", 200, role("member"));
  await http(
    "member: secrets are admin-only",
    a.member.token,
    "POST",
    "/api/secrets",
    403,
    undefined,
    {
      name: "DEVLAB_ROLE_CHECK",
      value: "should-not-be-stored",
    },
  );
  await http("member: user lookup is admin-only", a.member.token, "GET", lookup, 403);
  await http("viewer: /api/auth/me", a.viewer.token, "GET", "/api/auth/me", 200, role("viewer"));
  await http("viewer: read-only", a.viewer.token, "POST", "/api/jobs", 403, undefined, {
    name: "viewer job",
    promptTemplate: "nope",
    agentRuntime: "claude-code",
  });
  await http("no token", null, "GET", "/api/tasks", 401);
  await http("unknown PAT", `optio_pat_${"0".repeat(64)}`, "GET", "/api/auth/me", 401);

  await ws("WS: admin PAT", "/ws/events", wsProtocols(a.admin.token), "in");
  const wsToken = await api<{ token: string }>("/api/auth/ws-token")
    .then((b) => b.token)
    .catch(() => "unavailable");
  await ws("WS: /api/auth/ws-token token", "/ws/events", wsProtocols(wsToken), "in");
  await ws("WS: ws-token is single-use", "/ws/events", wsProtocols(wsToken), 4401);
  await ws("WS: no token", "/ws/events", ["optio-ws-v1"], 4401);
  const terminalId = m.local?.recordedAgentSession?.terminalId;
  if (terminalId) {
    const stream = `/ws/local/terminals/${terminalId}/stream`;
    await ws("WS: terminal stream, owner's PAT", stream, wsProtocols(a.admin.token), "in");
    await ws("WS: terminal stream, another user's PAT", stream, wsProtocols(a.member.token), 4403);
  }
  return checks;
}

// ---------------------------------------------------------------------------------------------
// Lifecycle.

let apiServer: ApiServerHandle | undefined;
let infra: RunInfra | undefined;
let stopping = false;
let apiExited = false;

async function shutdown(code: number, reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  log(`shutting down (${reason})`);
  if (code === 0) setState({ phase: "stopping" });
  try {
    await apiServer?.stop();
  } catch {
    /* already gone */
  }
  try {
    await infra?.drop();
  } catch {
    /* swept later by the test globalSetup once this pid is gone */
  }
  rmSync(join(ARGS.runDir, "api.pid"), { force: true });
  process.exit(code);
}

process.on("SIGTERM", () => void shutdown(0, "SIGTERM"));
process.on("SIGINT", () => void shutdown(0, "SIGINT"));
process.on("SIGHUP", () => {
  /* keep running when the launching shell goes away */
});
process.on("exit", () => {
  // Last resort (e.g. an uncaught throw): never leave the API server orphaned.
  const pid = apiServer?.proc.pid;
  if (pid && !apiExited) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      /* gone */
    }
  }
});

async function provisionDatabase(): Promise<void> {
  // Containers + migrated template + redis-lease sequence: the same global setup the API test
  // tiers use. It resolves OPTIO_TEST_PG_URL / OPTIO_TEST_REDIS_URL into process.env. The
  // database name embeds this process's pid, so the tiers' leftover sweep never drops it while
  // this launcher is alive.
  await buildTestInfra();
  infra = await provisionRunInfra("optio_e2e_run_");
  process.env.DATABASE_URL = infra.testDatabaseUrl;
  process.env.REDIS_URL = infra.testRedisUrl;
  process.env.OPTIO_ENCRYPTION_KEY =
    "1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988";
  setState({ dbName: infra.dbName, redisUrl: infra.testRedisUrl });
}

async function main(): Promise<void> {
  mkdirSync(ARGS.runDir, { recursive: true });
  setState({ phase: "starting" });
  const kubeServer = await startFakeKube();
  const apiEnv = hermeticEnv(kubeServer);

  log("starting test infra containers...");
  execFileSync("bash", [join(REPO_ROOT, "scripts", "test-infra.sh"), "start"], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  await provisionDatabase();
  if (ARGS.auth) {
    log("auth enabled: creating users, workspaces and personal access tokens...");
    AUTH = await createPrincipals();
    setState({ workspaceId: AUTH.workspace.id });
  }

  log(
    `starting the API server on ${API_URL} (fake runtime, auth ${ARGS.auth ? "ENABLED" : "disabled"})...`,
  );
  apiServer = await startApiServer({
    port: ARGS.port,
    logLevel: ARGS.logLevel,
    readyTimeoutMs: 180_000,
    env: {
      ...apiEnv,
      ...API_ENV_OVERRIDES,
      OPTIO_AUTH_DISABLED: ARGS.auth ? "false" : "true",
      // Android push with a recording transport (see --fcm-fake above).
      ...(ARGS.fcmFake
        ? {
            OPTIO_FCM_TRANSPORT: "fake",
            OPTIO_FCM_FAKE_OUTBOX: join(ARGS.runDir, "fcm-outbox.jsonl"),
          }
        : {}),
    },
  });
  const api = apiServer;
  writeFileSync(join(ARGS.runDir, "api.pid"), `${api.proc.pid}\n`);
  // Boot output so far lives in the handle's ring buffer; stream the rest into our log.
  process.stdout.write(api.logs() + "\n");
  api.proc.stdout?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  api.proc.stderr?.on("data", (chunk: Buffer) => process.stdout.write(chunk));
  api.proc.on("exit", (code) => {
    apiExited = true;
    if (stopping) return;
    log(`the API server exited unexpectedly (code ${code})`);
    setState({ phase: "failed", error: `API server exited (code ${code})` });
    void shutdown(1, "API exited");
  });
  setState({ apiPid: api.proc.pid });
  log(`API healthy at ${API_URL}`);

  let manifest: Json | null = null;
  if (ARGS.seed) {
    setState({ phase: "seeding" });
    manifest = await seed();
  } else if (AUTH) {
    manifest = baseManifest(); // no data, but the tokens
  }
  if (AUTH && manifest) {
    setState({ phase: "checking auth" });
    const checks = await runAuthChecks(manifest, AUTH);
    const failed = checks.filter((c) => !c.ok);
    manifest.auth.checks = checks;
    for (const c of failed) {
      (manifest.errors as Json[]).push({ step: `auth check: ${c.name}`, error: c.detail });
      log(`auth check failed: ${c.name}: ${c.detail}`);
    }
    log(`auth checks: ${checks.length - failed.length}/${checks.length} passed`);
    setState({ authChecks: `${checks.length - failed.length}/${checks.length} passed` });
  }
  if (manifest) {
    writeJsonAtomic(join(ARGS.runDir, "seed.json"), manifest);
    const errors = (manifest.errors as unknown[]).length;
    log(`seed complete${errors ? ` with ${errors} skipped step(s), see seed.json "errors"` : ""}`);
    setState({ seedErrors: errors });
  }
  setState({ phase: "ready", readyAt: new Date().toISOString() });
  log(
    `ready: host ${API_URL}, emulator ${EMULATOR_API_URL}` +
      (AUTH ? " (auth enabled; tokens under `auth` in seed.json)" : ""),
  );
}

main().catch((err) => {
  console.error("[android-api] failed:", err);
  try {
    setState({ phase: "failed", error: err instanceof Error ? err.message : String(err) });
  } catch {
    /* run dir gone */
  }
  void shutdown(1, "startup failed");
});
