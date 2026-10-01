/**
 * Model providers on a machine, and the session-order timestamp, against a
 * real database: the spawn carries the provider's region and AWS profile but
 * never a credential; a daemon from before providers is refused instead of
 * quietly running on its own sign-in; typing stamps `last_interacted_at`.
 */
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { localTerminals } from "../db/schema.js";
import * as relay from "./local-relay.js";
import { registerHost } from "./local-host-service.js";
import { createTerminal, noteInteraction } from "./local-terminal-service.js";
import { createModelProvider } from "./model-provider-service.js";

class FakeDaemonSocket implements relay.RelaySocket {
  readyState = 1;
  sent: string[] = [];
  send(data: string | Buffer) {
    this.sent.push(String(data));
  }
  close() {
    this.readyState = 3;
  }
  spawns(): Array<Record<string, any>> {
    return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "spawn");
  }
}

const DIRS = [{ path: "/home/dev/scratch" }];

async function machine(caps: { modelProviders?: boolean }) {
  const host = await registerHost({
    userId: null,
    workspaceId: null,
    hostname: `it-providers-${Math.random().toString(36).slice(2, 8)}`,
    platform: "darwin",
    arch: "arm64",
    daemonVersion: "0.1.0",
    dirs: DIRS,
  });
  const daemon = new FakeDaemonSocket();
  relay.registerDaemon(host.id, null, daemon, caps);
  return { host, daemon };
}

async function provider() {
  return createModelProvider(
    {
      name: "Bedrock",
      owner: "workspace",
      kind: "bedrock",
      agents: ["claude-code", "codex"],
      region: "eu-west-1",
      localAwsProfile: "bedrock",
      podCredential: "bearer-token",
      credentials: { type: "bearer-token", bearerToken: "never-on-a-laptop" },
    },
    { workspaceId: null, userId: null, isAdmin: true },
  );
}

describe("model providers on a machine", () => {
  it("spawns the agent with the provider's launch and no credential", async () => {
    const { host, daemon } = await machine({ modelProviders: true });
    const p = await provider();
    const terminal = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/scratch",
      spec: { kind: "agent", agent: "codex", prompt: "hi", model: "openai.gpt-5.4" },
      modelProviderId: p.id,
    });
    expect(terminal.state).toBe("launching");
    const [spawn] = daemon.spawns();
    expect(spawn.spec.provider).toEqual({
      kind: "bedrock",
      providerId: p.id,
      name: "Bedrock",
      region: "eu-west-1",
      awsProfile: "bedrock",
    });
    expect(JSON.stringify(daemon.sent)).not.toContain("never-on-a-laptop");
  });

  it("refuses a daemon that can't run providers", async () => {
    const { host, daemon } = await machine({});
    const p = await provider();
    const terminal = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/scratch",
      spec: { kind: "agent", agent: "claude-code" },
      modelProviderId: p.id,
    });
    expect(terminal.state).toBe("error");
    expect(terminal.errorMessage).toMatch(/can't use model providers yet/);
    expect(daemon.spawns()).toHaveLength(0);
  });

  it("ignores a provider a client put in the spec unless it resolves", async () => {
    const { host } = await machine({ modelProviders: true });
    await expect(
      createTerminal({
        host,
        userId: null,
        workspaceId: null,
        dir: "/home/dev/scratch",
        spec: {
          kind: "agent",
          agent: "claude-code",
          provider: {
            kind: "bedrock",
            providerId: "00000000-0000-0000-0000-000000000000",
            name: "forged",
            region: "us-east-1",
          },
        },
      }),
    ).rejects.toThrow(/removed/);
  });
});

describe("session order", () => {
  it("stamps last_interacted_at when someone types, at most once a minute", async () => {
    const { host } = await machine({});
    const terminal = await createTerminal({
      host,
      userId: null,
      workspaceId: null,
      dir: "/home/dev/scratch",
      spec: { kind: "shell" },
    });
    expect(terminal.lastInteractedAt).toBeNull();
    await noteInteraction(terminal.id);
    const [first] = await db
      .select()
      .from(localTerminals)
      .where(eq(localTerminals.id, terminal.id));
    expect(first.lastInteractedAt).toBeInstanceOf(Date);
    await noteInteraction(terminal.id);
    const [second] = await db
      .select()
      .from(localTerminals)
      .where(eq(localTerminals.id, terminal.id));
    expect(second.lastInteractedAt?.getTime()).toBe(first.lastInteractedAt?.getTime());
  });
});
