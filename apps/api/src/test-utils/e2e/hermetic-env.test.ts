import { execFileSync, execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  createHermeticEnv,
  hermeticBaseEnv,
  withStubsFirst,
  type HermeticEnv,
} from "./hermetic-env.js";

describe("hermeticBaseEnv", () => {
  it("drops credentials, cluster access and Optio settings, keeps the test infra", () => {
    const env = hermeticBaseEnv({
      PATH: "/usr/bin",
      HOME: "/Users/dev",
      NODE_ENV: "test",
      DATABASE_URL: "postgres://test",
      REDIS_URL: "redis://test",
      OPTIO_TEST_PG_URL: "postgres://admin",
      OPTIO_ENCRYPTION_KEY: "test-key",
      OPTIO_API_URL: "https://optio.example.com",
      OPTIO_AUTH_DISABLED: "true",
      GITHUB_TOKEN: "ghp_x",
      GH_TOKEN: "gho_x",
      GITLAB_TOKEN: "glpat-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
      OPENAI_API_KEY: "sk-x",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x",
      CLAUDE_CONFIG_DIR: "/Users/dev/.claude",
      AWS_SECRET_ACCESS_KEY: "aws-x",
      GOOGLE_APPLICATION_CREDENTIALS: "/Users/dev/gcp.json",
      SLACK_SIGNING_SECRET: "slack-x",
      KUBECONFIG: "/Users/dev/.kube/config",
    });
    expect(Object.keys(env).sort()).toEqual([
      "DATABASE_URL",
      "HOME",
      "NODE_ENV",
      "OPTIO_ENCRYPTION_KEY",
      "OPTIO_TEST_PG_URL",
      "PATH",
      "REDIS_URL",
    ]);
  });
});

describe("createHermeticEnv", () => {
  let hermetic: HermeticEnv | null = null;
  afterEach(async () => {
    await hermetic?.stop();
    hermetic = null;
  });

  it("points KUBECONFIG at a read-only fake cluster", async () => {
    hermetic = await createHermeticEnv();
    const kubeconfig = readFileSync(hermetic.env.KUBECONFIG, "utf-8");
    expect(kubeconfig).toContain(`server: ${hermetic.kubeUrl}`);

    const nodes = (await (await fetch(`${hermetic.kubeUrl}/api/v1/nodes`)).json()) as {
      items: Array<{ metadata: { name: string } }>;
    };
    expect(nodes.items.map((n) => n.metadata.name)).toEqual(["test-node"]);

    const pods = (await (
      await fetch(`${hermetic.kubeUrl}/api/v1/namespaces/optio/pods?labelSelector=app%3Doptio-api`)
    ).json()) as { items: Array<{ metadata: { name: string } }> };
    expect(pods.items.map((p) => p.metadata.name)).toEqual(["optio-api-0"]);

    const write = await fetch(`${hermetic.kubeUrl}/api/v1/namespaces/optio/pods/optio-api-0`, {
      method: "DELETE",
    });
    expect(write.status).toBe(403);
    expect((await fetch(`${hermetic.kubeUrl}/api/v1/secrets`)).status).toBe(404);
  });

  it("hides this machine's Claude login and stubs kubectl / helm", async () => {
    hermetic = await createHermeticEnv();
    const env = { ...process.env, ...hermetic.env };
    // What auth-service runs to read the Keychain: not found.
    expect(() =>
      execSync('security find-generic-password -s "Claude Code-credentials" -w', {
        env,
        stdio: "pipe",
      }),
    ).toThrow();
    for (const tool of ["kubectl", "helm"]) {
      expect(() => execFileSync(tool, ["version"], { env, stdio: "pipe" }), tool).toThrow(
        /disabled for test API servers/,
      );
    }
    expect(readdirSync(hermetic.env.HOME)).toEqual([]);
    expect(readdirSync(hermetic.env.CLAUDE_CONFIG_DIR)).toEqual([]);
  });

  it("keeps the stubs first on a PATH the caller brought (e.g. its own shims)", async () => {
    hermetic = await createHermeticEnv();
    expect(withStubsFirst({ PATH: "/shims:/usr/bin" }, hermetic).PATH).toBe(
      `${hermetic.binDir}:/shims:/usr/bin`,
    );
    expect(withStubsFirst({ ...hermetic.env }, hermetic).PATH).toBe(hermetic.env.PATH);
    expect(hermetic.env.PATH.split(":")[0]).toBe(hermetic.binDir);
  });

  it("removes its scratch directory on stop", async () => {
    const h = await createHermeticEnv();
    const home = h.env.HOME;
    await h.stop();
    expect(existsSync(home)).toBe(false);
    await expect(fetch(`${h.kubeUrl}/api/v1/nodes`)).rejects.toThrow();
  });
});
