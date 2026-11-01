/**
 * The deployment's own secrets (no workspace: the `global` rows a deployment
 * admin saves) against real Postgres. Anyone signed in can create a
 * workspace, so work there must not get them by naming them — as a pod
 * secret, or in a connection's or MCP server's `${{NAME}}`. The founding
 * workspace keeps them (a single-workspace install is unchanged), and the
 * deployment's fixed uses (agent sign-in, git) still read them.
 */
import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { logger } from "../logger.js";
import { buildAgentEnvironment } from "./agent-environment-service.js";
import { connectionCatalog } from "./connection-catalog-service.js";
import { createConnection, seedBuiltInProviders } from "./connection-service.js";
import { foundingWorkspaceId } from "./founding-workspace.js";
import { createMcpServer } from "./mcp-server-service.js";
import {
  listPickableSecrets,
  mayUseDeploymentSecrets,
  podSecretsSelectionError,
  resolvePodSecrets,
  retrieveSecretWithFallback,
  storeSecret,
} from "./secret-service.js";

const uniq = () => randomBytes(4).toString("hex");
const REPO = "https://github.com/acme/deployment-secrets";

let founding: string;
let foreign: string;
let attacker: string;

async function insertUser() {
  const [u] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${uniq()}`,
      email: `${uniq()}@deployment-secrets.it`,
      displayName: "someone",
    })
    .returning();
  return u.id;
}

beforeAll(async () => {
  await seedBuiltInProviders();
  founding = (await foundingWorkspaceId()) ?? (await insertWorkspace()).id;
  // A workspace someone made by signing in.
  foreign = (await insertWorkspace()).id;
  attacker = await insertUser();
  await storeSecret("AWS_SECRET_ACCESS_KEY", "deployment-aws-secret", "global");
  await storeSecret("STRIPE_KEY", "deployment-stripe-key", "global");
  // A repo-scoped row saved before secrets had a workspace: the deployment's too.
  await storeSecret("LEGACY_REPO_KEY", "deployment-legacy-repo", REPO);
  // What the foreign workspace and its member really own.
  await storeSecret("FOREIGN_REPO_KEY", "foreign-repo-value", REPO, foreign);
  await storeSecret("MY_TOKEN", "attacker-own-token", "user", null, attacker);
});

/** Every value an environment carries, base64-decoded too (files are encoded). */
function haystack(env: Record<string, string>): string {
  return (
    JSON.stringify(env) +
    Object.values(env)
      .map((v) => {
        try {
          return Buffer.from(v, "base64").toString("utf8");
        } catch {
          return "";
        }
      })
      .join("\n")
  );
}

describe("the deployment's secrets outside the founding workspace", () => {
  it("only the founding workspace (or no workspace) may use them", async () => {
    expect(await mayUseDeploymentSecrets(founding)).toBe(true);
    expect(await mayUseDeploymentSecrets(null)).toBe(true);
    expect(await mayUseDeploymentSecrets(foreign)).toBe(false);
  });

  it("pod secrets: another workspace can neither pick nor receive them", async () => {
    const pickable = await listPickableSecrets(foreign, attacker);
    expect(pickable).not.toContainEqual(expect.objectContaining({ name: "STRIPE_KEY" }));
    expect(pickable).not.toContainEqual(expect.objectContaining({ name: "AWS_SECRET_ACCESS_KEY" }));
    expect(pickable).toContainEqual({ name: "MY_TOKEN", owner: "me" });

    for (const name of ["STRIPE_KEY", "AWS_SECRET_ACCESS_KEY"]) {
      expect(
        await podSecretsSelectionError([name], { workspaceId: foreign, ownerUserId: null }),
      ).not.toBeNull();
      expect(
        await podSecretsSelectionError([name], { workspaceId: foreign, ownerUserId: attacker }),
      ).not.toBeNull();
    }

    // Work saved before the fix still names them: the run gets none of them.
    const resolved = await resolvePodSecrets(
      ["STRIPE_KEY", "AWS_SECRET_ACCESS_KEY", "LEGACY_REPO_KEY", "FOREIGN_REPO_KEY", "MY_TOKEN"],
      { repoUrl: REPO, workspaceId: foreign, ownerUserId: attacker },
    );
    expect(resolved.env).toEqual({
      FOREIGN_REPO_KEY: "foreign-repo-value",
      MY_TOKEN: "attacker-own-token",
    });
    expect(resolved.missing.sort()).toEqual(
      ["AWS_SECRET_ACCESS_KEY", "LEGACY_REPO_KEY", "STRIPE_KEY"].sort(),
    );
  });

  it("pod secrets: the founding workspace keeps picking and receiving them", async () => {
    const pickable = await listPickableSecrets(founding, null);
    expect(pickable).toContainEqual({ name: "STRIPE_KEY", owner: "workspace" });
    expect(pickable).toContainEqual({ name: "AWS_SECRET_ACCESS_KEY", owner: "workspace" });
    expect(
      await podSecretsSelectionError(["STRIPE_KEY"], { workspaceId: founding, ownerUserId: null }),
    ).toBeNull();
    const resolved = await resolvePodSecrets(["STRIPE_KEY", "LEGACY_REPO_KEY"], {
      repoUrl: REPO,
      workspaceId: founding,
      ownerUserId: null,
    });
    expect(resolved.env).toEqual({
      STRIPE_KEY: "deployment-stripe-key",
      LEGACY_REPO_KEY: "deployment-legacy-repo",
    });
  });

  it("a name work picks skips them in another workspace; the deployment's fixed uses don't", async () => {
    await expect(
      retrieveSecretWithFallback("STRIPE_KEY", "global", foreign, attacker, { pickedByWork: true }),
    ).rejects.toThrow(/Secret not found/);
    expect(
      await retrieveSecretWithFallback("STRIPE_KEY", "global", founding, null, {
        pickedByWork: true,
      }),
    ).toBe("deployment-stripe-key");
    // Agent sign-in, git and cloud credentials are the deployment's own
    // choice of name and still serve every workspace (unchanged here).
    expect(await retrieveSecretWithFallback("STRIPE_KEY", "global", foreign)).toBe(
      "deployment-stripe-key",
    );
  });

  it("a connection's or MCP server's ${{NAME}} in another workspace doesn't reach them", async () => {
    const build = async (workspaceId: string, ownerUserId: string | null) => {
      const tag = uniq();
      await createConnection(
        {
          name: `grab-${tag}`,
          providerSlug: "custom-mcp",
          ownerUserId,
          config: {
            command: "sh",
            args: "-c\nenv",
            env: "A=${{AWS_SECRET_ACCESS_KEY}}\nB=${{MY_TOKEN}}",
          },
          assignments: [{ repoId: null }],
        },
        workspaceId,
      );
      await createMcpServer(
        {
          name: `srv-${tag}`,
          command: "node",
          args: ["--key", "${{STRIPE_KEY}}"],
          env: { C: "${{STRIPE_KEY}}", D: "${{FOREIGN_REPO_KEY}}" },
          repoUrl: REPO,
          ownerUserId,
        },
        workspaceId,
      );
      return haystack(
        await buildAgentEnvironment(
          { repoUrl: REPO, agentType: "claude-code", workspaceId, ownerUserId },
          logger,
        ),
      );
    };

    const foreignEnv = await build(foreign, attacker);
    expect(foreignEnv).not.toContain("deployment-aws-secret");
    expect(foreignEnv).not.toContain("deployment-stripe-key");
    // What is its own still resolves.
    expect(foreignEnv).toContain("attacker-own-token");
    expect(foreignEnv).toContain("foreign-repo-value");

    const foundingEnv = await build(founding, null);
    expect(foundingEnv).toContain("deployment-aws-secret");
    expect(foundingEnv).toContain("deployment-stripe-key");
  });

  it("the connections catalog offers them only to the founding workspace", async () => {
    const secretNames = async (workspaceId: string) =>
      (await connectionCatalog({ userId: null, workspaceId, isAdmin: true }))
        .filter((e) => e.kind === "secret")
        .map((e) => e.name);
    expect(await secretNames(foreign)).not.toContain("STRIPE_KEY");
    expect(await secretNames(founding)).toContain("STRIPE_KEY");
  });
});
