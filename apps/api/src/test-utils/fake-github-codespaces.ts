import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { openSealedBox, x25519Public } from "../services/remote-workspaces/sealed-box.js";

/**
 * An in-process GitHub REST API — the Codespaces calls Optio makes
 * (services/remote-workspaces/codespaces.ts), shaped as
 * https://docs.github.com/en/rest/codespaces describes them (API version
 * 2022-11-28): the token's user, its repositories, a repository's machine
 * types and dev containers, codespaces and their lifecycle, and the user's
 * Codespaces secrets, which it opens with its own key pair (as GitHub does:
 * a sealed box to the public key it hands out) so a test reads what Optio
 * stored. A new codespace reads `Queued` once, then `Available`; a stopped
 * one `ShuttingDown`, then `Shutdown`.
 *
 *   const gh = await startFakeGitHubCodespaces({ token: "ghp_1" });
 *   gh.codespaces.get(name).state; gh.secrets.get("OPTIO_PAIRING_…").value
 *   await gh.close();
 */

export interface FakeCodespace {
  id: number;
  name: string;
  display_name: string;
  repository: { id: number; full_name: string; name: string };
  state: string;
  machine: string;
  devcontainer_path: string | null;
  ref: string | null;
  idle_timeout_minutes: number;
  /** The states it reads next (one per GET). */
  pending: string[];
}

export interface FakeGitHubCall {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingMessage["headers"];
}

export interface FakeGitHubCodespaces {
  url: string;
  user: { id: number; login: string; email: string };
  codespaces: Map<string, FakeCodespace>;
  /** The user's Codespaces secrets, opened: the value and the repositories that see it. */
  secrets: Map<string, { value: string; repositories: number[] }>;
  calls: FakeGitHubCall[];
  callsTo(route: string): FakeGitHubCall[];
  failNext(route: string, status: number): void;
  close(): Promise<void>;
}

const REPOS = [
  {
    id: 9001,
    name: "app",
    full_name: "acme/app",
    description: "The app",
    owner: { login: "acme" },
  },
  { id: 9002, name: "docs", full_name: "acme/docs", description: null, owner: { login: "acme" } },
];

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function startFakeGitHubCodespaces(
  opts: { token?: string; expires?: string } = {},
): Promise<FakeGitHubCodespaces> {
  const token = opts.token ?? "ghp_fake";
  const user = { id: 101, login: "octo", email: "octo@example.com" };
  const secretKey = new Uint8Array(randomBytes(32));
  const publicKey = x25519Public(secretKey);
  const codespaces = new Map<string, FakeCodespace>();
  const secrets = new Map<string, { value: string; repositories: number[] }>();
  const calls: FakeGitHubCall[] = [];
  const failures = new Map<string, number>();
  let seq = 0;

  const view = (c: FakeCodespace) => ({
    id: c.id,
    name: c.name,
    display_name: c.display_name,
    environment_id: `env-${c.id}`,
    owner: { id: user.id, login: user.login },
    billable_owner: { id: user.id, login: user.login },
    repository: c.repository,
    machine: { name: c.machine, display_name: "2 cores, 8 GB RAM, 32 GB storage" },
    devcontainer_path: c.devcontainer_path,
    prebuild: false,
    created_at: "2026-10-25T10:00:00Z",
    updated_at: "2026-10-25T10:00:00Z",
    last_used_at: "2026-10-25T10:00:00Z",
    state: c.state,
    url: `https://api.github.com/user/codespaces/${c.name}`,
    git_status: { ahead: 0, behind: 0, has_unpushed_changes: false, ref: c.ref ?? "main" },
    location: "WestEurope",
    idle_timeout_minutes: c.idle_timeout_minutes,
    web_url: `https://${c.name}.github.dev`,
  });

  const server: Server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://fake-github");
    const path = u.pathname.replace(/\/+$/, "");
    const body = req.method === "GET" ? null : await bodyOf(req);
    const route = `${req.method} ${path}`;
    calls.push({ method: req.method ?? "", path, body, headers: req.headers });
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(payload === undefined ? "" : JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${token}`) {
      return send(401, {
        message: "Bad credentials",
        documentation_url: "https://docs.github.com/rest",
      });
    }
    if (req.headers["x-github-api-version"] !== "2022-11-28") {
      return send(400, { message: "Unsupported API version" });
    }
    const failure = failures.get(route);
    if (failure) {
      failures.delete(route);
      return send(failure, { message: "injected failure" });
    }
    const b = (body ?? {}) as Record<string, any>;
    const expiry: Record<string, string> = opts.expires
      ? { "github-authentication-token-expiration": opts.expires }
      : {};

    if (route === "GET /user") return send(200, user, expiry);
    if (route === "GET /user/repos") return send(200, REPOS);
    let m = path.match(/^\/orgs\/([^/]+)\/repos$/);
    if (m && req.method === "GET") {
      return send(
        200,
        REPOS.filter((r) => r.owner.login === m![1]),
      );
    }
    m = path.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/codespaces(?:\/(machines|devcontainers))?)?$/);
    if (m) {
      const repo = REPOS.find((r) => r.full_name === `${m![1]}/${m![2]}`);
      if (!repo) return send(404, { message: "Not Found" });
      if (m[3] === "machines" && req.method === "GET") {
        return send(200, {
          total_count: 2,
          machines: [
            { name: "basicLinux32gb", display_name: "2 cores, 8 GB RAM, 32 GB storage" },
            { name: "standardLinux32gb", display_name: "4 cores, 16 GB RAM, 32 GB storage" },
          ],
        });
      }
      if (m[3] === "devcontainers" && req.method === "GET") {
        return send(200, {
          total_count: 1,
          devcontainers: [{ path: ".devcontainer/devcontainer.json", name: "Optio" }],
        });
      }
      if (!m[3] && path.endsWith("/codespaces") && req.method === "POST") {
        const id = ++seq;
        const c: FakeCodespace = {
          id,
          name: `${user.login}-fluffy-space-${randomBytes(5).toString("hex")}`,
          display_name: String(b.display_name ?? ""),
          repository: { id: repo.id, full_name: repo.full_name, name: repo.name },
          state: "Queued",
          machine: String(b.machine ?? "basicLinux32gb"),
          devcontainer_path: (b.devcontainer_path as string) ?? null,
          ref: (b.ref as string) ?? null,
          idle_timeout_minutes: Number(b.idle_timeout_minutes ?? 30),
          pending: ["Available"],
        };
        codespaces.set(c.name, c);
        return send(201, view(c));
      }
      if (!m[3] && !path.endsWith("/codespaces") && req.method === "GET") return send(200, repo);
    }
    if (route === "GET /user/codespaces") {
      const all = [...codespaces.values()].filter((c) => c.state !== "Deleted");
      return send(200, { total_count: all.length, codespaces: all.map(view) });
    }
    if (route === "GET /user/codespaces/secrets/public-key") {
      return send(200, { key_id: "kid-1", key: Buffer.from(publicKey).toString("base64") });
    }
    m = path.match(/^\/user\/codespaces\/secrets\/([^/]+)$/);
    if (m) {
      const name = m[1];
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^GITHUB_/i.test(name)) {
        return send(422, { message: "Invalid secret name" });
      }
      if (req.method === "PUT") {
        if (b.key_id !== "kid-1") return send(422, { message: "Bad key_id" });
        const opened = openSealedBox(
          new Uint8Array(Buffer.from(String(b.encrypted_value ?? ""), "base64")),
          publicKey,
          secretKey,
        );
        if (!opened) return send(422, { message: "Couldn't decrypt the secret" });
        const existed = secrets.has(name.toUpperCase());
        secrets.set(name.toUpperCase(), {
          value: Buffer.from(opened).toString("utf8"),
          repositories: (b.selected_repository_ids as number[]) ?? [],
        });
        res.writeHead(existed ? 204 : 201);
        return res.end();
      }
      if (req.method === "DELETE") {
        if (!secrets.delete(name.toUpperCase())) return send(404, { message: "Not Found" });
        res.writeHead(204);
        return res.end();
      }
    }
    m = path.match(/^\/user\/codespaces\/([^/]+)(?:\/(start|stop))?$/);
    if (m) {
      const c = codespaces.get(m[1]);
      if (!c || c.state === "Deleted") return send(404, { message: "Not Found" });
      if (!m[2] && req.method === "GET") {
        if (c.pending.length > 0) c.state = c.pending.shift()!;
        return send(200, view(c));
      }
      if (!m[2] && req.method === "DELETE") {
        c.state = "Deleted";
        return send(202, {});
      }
      if (m[2] === "start" && req.method === "POST") {
        if (c.state !== "Shutdown") return send(409, { message: "Codespace is not stopped" });
        c.state = "Starting";
        c.pending = ["Available"];
        return send(200, view(c));
      }
      if (m[2] === "stop" && req.method === "POST") {
        c.state = "ShuttingDown";
        c.pending = ["Shutdown"];
        return send(200, view(c));
      }
    }
    return send(404, { message: `No fake for ${route}` });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    user,
    codespaces,
    secrets,
    calls,
    callsTo: (route) => calls.filter((c) => `${c.method} ${c.path}` === route),
    failNext: (route, status) => void failures.set(route, status),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
