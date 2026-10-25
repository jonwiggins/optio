/**
 * The Codespaces, Daytona and E2B clients against in-process fakes of their
 * APIs (test-utils/fake-*.ts), shaped as each provider's published API
 * reference describes them: what Optio sends, and what it makes of the
 * answers. The bundle never travels in a provider's own record of the
 * workspace (Daytona's `env`, E2B's metadata): it goes in the start script's
 * environment, or sealed in a codespace's own secret.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { startFakeDaytona, type FakeDaytona } from "../../test-utils/fake-daytona.js";
import { startFakeE2b, type FakeE2b } from "../../test-utils/fake-e2b.js";
import {
  startFakeGitHubCodespaces,
  type FakeGitHubCodespaces,
} from "../../test-utils/fake-github-codespaces.js";
import {
  CodespacesClient,
  codespacesProvider,
  pairingSecretName,
  repositoryOf,
  setCodespacesPollMsForTests,
} from "./codespaces.js";
import { DaytonaClient, daytonaStatus } from "./daytona.js";
import { E2bClient, connectEnvelope, readEnvelopes, setEnvdUrlForTests } from "./e2b.js";
import { START_COMMAND, START_SCRIPT, startScriptEnv } from "./start-script.js";
import { RemoteWorkspaceError, type CreateWorkspaceInput, type PairingBundle } from "./types.js";

const bundle: PairingBundle = {
  OPTIO_SERVER: "https://optio.example.com",
  OPTIO_TOKEN: "optio_pat_pairing",
  OPTIO_LOCAL_HOST_ID: "host-1",
};

function input(extra: Partial<CreateWorkspaceInput> = {}): CreateWorkspaceInput {
  const wanted = { repo_url: "https://github.com/acme/app", ...(extra.wanted ?? {}) };
  return {
    templateVersionId: "optio-node",
    name: "optio-fix-it-abc123",
    declared: [],
    bundle,
    checkoutDir: "/home/user/repo",
    ttlMs: 2 * 60 * 60_000,
    env: startScriptEnv({
      bundle,
      checkoutDir: "/home/user/repo",
      hostname: "w",
      parameters: wanted,
    }),
    ...extra,
    wanted,
  };
}

beforeAll(() => {
  vi.stubEnv("OPTIO_OUTBOUND_ALLOWED_HOSTS", "127.0.0.1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

// ── Daytona ──────────────────────────────────────────────────────────────────

describe("Daytona", () => {
  let daytona: FakeDaytona;
  const client = (token = "dtn_1", organizationId: string | null = null) =>
    new DaytonaClient({ url: daytona.url, token, organizationId });

  beforeAll(async () => {
    daytona = await startFakeDaytona({ apiKey: "dtn_1" });
  });
  afterAll(() => daytona.close());

  it("signs in with the API key (Bearer), names the key, and reads its expiry", async () => {
    expect(await client().whoami()).toEqual({ id: "du-1", username: "API key optio" });
    expect((await client().tokenExpiry())?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    const err = await client("wrong")
      .whoami()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteWorkspaceError);
    expect((err as RemoteWorkspaceError).status).toBe(403);
    expect((err as Error).message).toMatch(/Daytona answered 401 to GET \/api-keys\/current/);
    expect((err as Error).message).not.toContain("wrong");
  });

  it("sends the organization header when the connection names one", async () => {
    await client("dtn_1", "org-9").whoami();
    expect(
      daytona.callsTo("GET /api-keys/current").at(-1)?.headers["x-daytona-organization-id"],
    ).toBe("org-9");
  });

  it("lists the active snapshots as templates", async () => {
    const { templates } = await client().templates();
    expect(templates.map((t) => [t.id, t.activeVersionId])).toEqual([
      ["optio-node", "optio-node"],
      ["optio-python", "optio-python"],
    ]);
    expect((await client().parameters()).map((p) => p.name)).toEqual(["repo_url", "target"]);
  });

  it("creates a sandbox from a snapshot with Optio's label and the TTL as its auto-stop — no bundle in its env", async () => {
    const ws = await client().create(input({ wanted: { target: "eu" } }));
    const [call] = daytona.callsTo("POST /sandbox");
    expect(call.body).toEqual({
      name: "optio-fix-it-abc123",
      snapshot: "optio-node",
      labels: { "optio-host-id": "host-1" },
      autoStopInterval: 120,
      target: "eu",
    });
    expect(JSON.stringify(call.body)).not.toContain("optio_pat_pairing");
    expect(ws).toMatchObject({ name: "optio-fix-it-abc123", status: "starting", ready: false });
    // Coming up, then started: ready for the start script.
    expect((await client().workspace(ws.id)).ready).toBe(true);
  });

  it("runs the start script through the toolbox, the bundle in its environment", async () => {
    const ws = await client().create(input());
    await client().workspace(ws.id); // started
    await client().runStartScript(await client().workspace(ws.id), input().env);
    const ran = daytona.executed.at(-1)!;
    expect(ran.sandboxId).toBe(ws.id);
    expect(ran.command).toBe(`sh -c '${START_COMMAND}'`);
    expect(ran.command).not.toContain("optio_pat_pairing");
    expect(ran.envs).toMatchObject({
      OPTIO_SERVER: "https://optio.example.com",
      OPTIO_TOKEN: "optio_pat_pairing",
      OPTIO_LOCAL_HOST_ID: "host-1",
      OPTIO_CHECKOUT_DIR: "/home/user/repo",
      OPTIO_REPO_URL: "https://github.com/acme/app",
      OPTIO_START_SCRIPT: START_SCRIPT,
    });
  });

  it("stops, starts and deletes; a deleted sandbox is gone (404)", async () => {
    const ws = await client().create(input());
    expect(await client().stop(ws.id)).toBe("stopped");
    const stopped = await client().workspace(ws.id);
    expect(stopped.status).toBe("stopped");
    await client().start(stopped, input());
    expect(daytona.sandboxes.get(ws.id)?.state).toBe("starting");
    expect(await client().remove(ws.id)).toBe("deleted");
    await expect(client().workspace(ws.id)).rejects.toMatchObject({ status: 404 });
    expect((await client().workspaces()).some((w) => w.id === ws.id)).toBe(false);
  });

  it("says why a sandbox will never come up", () => {
    expect(daytonaStatus("build_failed")).toBe("failed");
    expect(daytonaStatus("pulling_snapshot")).toBe("starting");
    expect(daytonaStatus("archived")).toBe("stopped");
  });
});

// ── E2B ──────────────────────────────────────────────────────────────────────

describe("E2B", () => {
  let e2b: FakeE2b;
  let restoreEnvd: () => void;
  const client = (token = "e2b_1") => new E2bClient({ url: e2b.url, token });

  beforeAll(async () => {
    e2b = await startFakeE2b({ apiKey: "e2b_1" });
    restoreEnvd = setEnvdUrlForTests((id) => `${e2b.url}/envd/${id}`);
  });
  afterAll(async () => {
    restoreEnvd();
    await e2b.close();
  });

  it("checks the API key with a template list (X-API-Key) and lists the ready templates", async () => {
    expect(await client().whoami()).toEqual({ id: null, username: "" });
    expect(e2b.callsTo("GET /v2/templates")[0].headers["x-api-key"]).toBe("e2b_1");
    await expect(client("bad").whoami()).rejects.toMatchObject({ status: 403 });
    const { templates } = await client().templates();
    expect(templates).toEqual([
      {
        id: "tpl-node",
        name: "optio-node",
        displayName: "acme/optio-node",
        description: null,
        organizationId: null,
        activeVersionId: "tpl-node",
      },
    ]);
    expect(await client().tokenExpiry()).toBeNull();
  });

  it("creates a sandbox that pauses at the end of its time, named in its metadata", async () => {
    const ws = await client().create(input({ templateVersionId: "tpl-node" }));
    const [call] = e2b.callsTo("POST /v2/sandboxes");
    expect(call.body).toEqual({
      templateID: "tpl-node",
      timeout: 7200,
      autoPause: true,
      metadata: { optio_name: "optio-fix-it-abc123", optio_host_id: "host-1" },
    });
    expect(JSON.stringify(call.body)).not.toContain("optio_pat_pairing");
    expect(ws).toMatchObject({ name: "optio-fix-it-abc123", status: "running", ready: true });
  });

  it("starts the daemon with envd's Process.Start, a Connect stream with the bundle in the environment", async () => {
    const ws = await client().create(input({ templateVersionId: "tpl-node" }));
    await client().runStartScript(ws, input().env);
    const ran = e2b.started.at(-1)!;
    expect(ran.sandboxId).toBe(ws.id);
    expect(ran.cmd).toBe("/bin/bash");
    expect(ran.args).toEqual(["-l", "-c", START_COMMAND]);
    expect(ran.envs).toMatchObject({
      OPTIO_TOKEN: "optio_pat_pairing",
      OPTIO_START_SCRIPT: START_SCRIPT,
    });
    // A current envd uses the template's own user: no Authorization header.
    expect(ran.user).toBeNull();
  });

  it("pauses, resumes and kills; a killed sandbox is gone (404)", async () => {
    const ws = await client().create(input({ templateVersionId: "tpl-node" }));
    expect(await client().stop(ws.id)).toBe("stopped");
    // Pausing a paused one is no error.
    expect(await client().stop(ws.id)).toBe("stopped");
    const paused = await client().workspace(ws.id);
    expect(paused).toMatchObject({ status: "stopped", ready: false });
    expect((await client().workspaces()).find((w) => w.id === ws.id)?.status).toBe("stopped");
    await client().start(paused, input({ ttlMs: null }));
    expect(e2b.sandboxes.get(ws.id)).toMatchObject({ state: "running", timeout: 3600 });
    expect(await client().remove(ws.id)).toBe("deleted");
    await expect(client().workspace(ws.id)).rejects.toMatchObject({ status: 404 });
  });

  it("frames Connect envelopes both ways", () => {
    const frames = readEnvelopes(
      Buffer.concat([connectEnvelope({ a: 1 }), connectEnvelope({ error: { code: "x" } }, 2)]),
    );
    expect(frames).toEqual([
      { flags: 0, message: { a: 1 } },
      { flags: 2, message: { error: { code: "x" } } },
    ]);
  });

  it("names the user for an envd older than 0.4.0", async () => {
    const old = await startFakeE2b({ apiKey: "e2b_1", envdVersion: "0.3.9" });
    const restore = setEnvdUrlForTests((id) => `${old.url}/envd/${id}`);
    try {
      const c = new E2bClient({ url: old.url, token: "e2b_1" });
      const ws = await c.create(input({ templateVersionId: "tpl-node" }));
      await c.runStartScript(ws, input().env);
      expect(old.started[0].user).toBe("user:");
    } finally {
      restore();
      await old.close();
    }
  });
});

// ── GitHub Codespaces ────────────────────────────────────────────────────────

describe("GitHub Codespaces", () => {
  let gh: FakeGitHubCodespaces;
  let restorePoll: () => void;
  const client = (token = "ghp_1") => new CodespacesClient({ url: gh.url, token });

  beforeAll(async () => {
    gh = await startFakeGitHubCodespaces({ token: "ghp_1", expires: "2026-12-01 00:00:00 UTC" });
    restorePoll = setCodespacesPollMsForTests(1);
  });
  afterAll(async () => {
    restorePoll();
    await gh.close();
  });
  beforeEach(() => gh.secrets.clear());

  it("signs in as the token's user, with the API version header, and reads the token's expiry", async () => {
    expect(await client().whoami()).toEqual({
      id: "101",
      username: "octo",
      email: "octo@example.com",
    });
    const call = gh.callsTo("GET /user")[0];
    expect(call.headers.authorization).toBe("Bearer ghp_1");
    expect(call.headers.accept).toBe("application/vnd.github+json");
    expect((await client().tokenExpiry())?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    await expect(client("bad").whoami()).rejects.toMatchObject({ status: 403 });
  });

  it("offers repositories as templates, and a repository's machine types and dev containers as parameters", async () => {
    const { templates } = await client().templates();
    expect(templates.map((t) => t.id)).toEqual(["acme/app", "acme/docs"]);
    expect((await client().templates("acme")).templates).toHaveLength(2);
    const params = await client().parameters("acme/app");
    expect(params.map((p) => p.name)).toEqual(["ref", "machine", "devcontainer_path"]);
    expect(params[1].options.map((o) => o.value)).toEqual(["basicLinux32gb", "standardLinux32gb"]);
    expect(params[2].options[0].value).toBe(".devcontainer/devcontainer.json");
  });

  it("creates a codespace, then seals the bundle into a secret named for it and only its repository", async () => {
    const ws = await client().create(
      input({
        templateVersionId: "acme/app",
        name: "optio-fix-it-abc123",
        wanted: { machine: "standardLinux32gb", ref: "main" },
      }),
    );
    const [call] = gh.callsTo("POST /repos/acme/app/codespaces");
    expect(call.body).toEqual({
      ref: "main",
      machine: "standardLinux32gb",
      display_name: "optio-fix-it-abc123",
      idle_timeout_minutes: 120,
    });
    const secret = gh.secrets.get(pairingSecretName(ws.name))!;
    expect(secret.repositories).toEqual([9001]);
    const exports = Buffer.from(secret.value, "base64").toString("utf8");
    expect(exports).toContain("export OPTIO_TOKEN='optio_pat_pairing'");
    expect(exports).toContain(`export OPTIO_LOCAL_HOSTNAME='${ws.name}'`);
    expect(ws).toMatchObject({ templateId: "acme/app", ownerId: "101", status: "starting" });
  });

  it("starts an existing codespace with a fresh secret, restarting one that runs so it reads it", async () => {
    const ws = await client().create(input({ templateVersionId: "acme/app" }));
    const up = await client().workspace(ws.id);
    expect(up.status).toBe("running");
    await client().start(up, input({ env: { ...input().env, OPTIO_TOKEN: "optio_pat_fresh" } }));
    expect(gh.callsTo(`POST /user/codespaces/${ws.id}/stop`)).toHaveLength(1);
    expect(gh.callsTo(`POST /user/codespaces/${ws.id}/start`)).toHaveLength(1);
    const value = Buffer.from(gh.secrets.get(pairingSecretName(ws.id))!.value, "base64").toString();
    expect(value).toContain("export OPTIO_TOKEN='optio_pat_fresh'");
  });

  it("drops the secret, stops and deletes", async () => {
    const ws = await client().create(input({ templateVersionId: "acme/app" }));
    await client().releasePairing({ id: ws.id, name: ws.name });
    expect(gh.secrets.has(pairingSecretName(ws.id))).toBe(false);
    // Already gone: no error.
    await client().releasePairing({ id: ws.id, name: ws.name });
    expect(await client().stop(ws.id)).toBe("stopping");
    expect(await client().remove(ws.id)).toBe("deleted");
    await expect(client().workspace(ws.id)).rejects.toMatchObject({ status: 404 });
  });

  it("deletes a codespace whose secret couldn't be written, and fails the start", async () => {
    gh.failNext("PUT /user/codespaces/secrets/x", 500); // another route: not hit
    gh.failNext("GET /user/codespaces/secrets/public-key", 500);
    await expect(client().create(input({ templateVersionId: "acme/app" }))).rejects.toThrow(
      /GitHub answered 500/,
    );
    const made = [...gh.codespaces.values()].at(-1)!;
    expect(made.state).toBe("Deleted");
  });

  it("takes the work's repository and its checkout from the work's repo_url", () => {
    expect(repositoryOf("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repositoryOf("git@github.com:acme/app.git")).toBe("acme/app");
    expect(repositoryOf("https://github.example.com/acme/app/")).toBe("acme/app");
    expect(repositoryOf("https://gitlab.example.com/group/sub/app")).toBeNull();
    expect(
      codespacesProvider.templateFromParameters!({ repo_url: "https://github.com/acme/app" }),
    ).toBe("acme/app");
    expect(codespacesProvider.defaultCheckoutDir({ templateId: "acme/docs", parameters: {} })).toBe(
      "/workspaces/docs",
    );
    expect(pairingSecretName("octo-fluffy-space-9x")).toBe("OPTIO_PAIRING_OCTO_FLUFFY_SPACE_9X");
  });
});
