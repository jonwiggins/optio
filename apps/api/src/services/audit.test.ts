import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";

const logAction = vi.hoisted(() => vi.fn());
vi.mock("./optio-action-service.js", () => ({ logAction }));
const recordSignInFailure = vi.hoisted(() => vi.fn());
vi.mock("../telemetry/site-metrics.js", () => ({ recordSignInFailure }));
const warn = vi.hoisted(() => vi.fn());
vi.mock("../logger.js", () => ({
  logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  auditAutoMergeSetting,
  auditEvent,
  auditSignInFailure,
  auditTokenSecret,
  cleanDetails,
  clientIpOf,
  likeSubActions,
  notAdminOnlyAction,
  notDeploymentWideAction,
  ownerDetails,
  tokenKindOf,
  workSpecAutoMerge,
} from "./audit.js";
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

/** A request as the auth plugin leaves it. */
function req(over: Partial<{ id: string; workspaceId: string | null; ip: string }> = {}) {
  return {
    ip: over.ip ?? "10.1.2.3",
    user: { id: over.id ?? "u-1", workspaceId: over.workspaceId ?? "ws-1" },
  } as unknown as FastifyRequest;
}

const written = () => logAction.mock.calls.map((c) => c[0]);

beforeEach(() => {
  logAction.mockReset().mockResolvedValue({});
  warn.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("cleanDetails", () => {
  it("drops undefined, cuts long strings and writes dates as ISO", () => {
    const at = new Date("2026-10-24T08:00:00.000Z");
    const out = cleanDetails({ a: undefined, b: "x".repeat(400), c: at, d: 3, e: ["f"] });
    expect(out).not.toHaveProperty("a");
    expect((out.b as string).length).toBe(301);
    expect(out.c).toBe("2026-10-24T08:00:00.000Z");
    expect(out).toMatchObject({ d: 3, e: ["f"] });
  });
});

describe("auditEvent", () => {
  it("takes the actor, workspace and client address from the request", async () => {
    await auditEvent({ req: req(), action: "team.leave", details: { teamId: "t-1" } });
    expect(written()).toEqual([
      {
        action: "team.leave",
        userId: "u-1",
        workspaceId: "ws-1",
        params: { teamId: "t-1" },
        success: true,
        clientIp: "10.1.2.3",
      },
    ]);
  });

  it("lets the caller name another actor, workspace or address (null included)", async () => {
    await auditEvent({
      req: req(),
      action: "pr.merge",
      userId: null,
      workspaceId: "ws-2",
      clientIp: null,
      success: false,
    });
    expect(written()[0]).toMatchObject({
      userId: undefined,
      workspaceId: "ws-2",
      clientIp: null,
      success: false,
    });
  });

  it("never throws: a failed write is logged and the promise resolves", async () => {
    logAction.mockRejectedValue(new Error("db down"));
    await expect(auditEvent({ action: "auth.sign_out" })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ action: "auth.sign_out" }),
      "Audit entry could not be written",
    );
  });

  it("works without a request (the reconciler)", async () => {
    await auditEvent({ action: "pr.merge", workspaceId: "ws-9", details: { via: "auto" } });
    expect(written()[0]).toMatchObject({ userId: undefined, workspaceId: "ws-9", clientIp: null });
  });
});

describe("clientIpOf", () => {
  it("is req.ip, or null", () => {
    expect(clientIpOf(req({ ip: "192.0.2.7" }))).toBe("192.0.2.7");
    expect(clientIpOf(null)).toBeNull();
    expect(clientIpOf({} as FastifyRequest)).toBeNull();
  });
});

describe("auditSignInFailure", () => {
  it("is deployment-wide, has no actor, and records why and with what name", async () => {
    await auditSignInFailure(req(), {
      provider: "ldap",
      reason: "invalid_credentials",
      username: "carol",
    });
    expect(written()[0]).toEqual({
      action: "auth.sign_in.failure",
      userId: undefined,
      workspaceId: null,
      success: false,
      clientIp: "10.1.2.3",
      params: { provider: "ldap", reason: "invalid_credentials", username: "carol" },
    });
    // Counted for the deployment's monitoring by provider and reason, never the name.
    expect(recordSignInFailure).toHaveBeenCalledWith("ldap", "invalid_credentials");
  });
});

describe("tokens", () => {
  it("names the token a secret holds (gateway-only access: the agent keys are gateway tokens)", () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    expect(tokenKindOf("GITLAB_TOKEN")).toBe("gitlab");
    expect(tokenKindOf("GITHUB_TOKEN")).toBe("github");
    expect(tokenKindOf("ANTHROPIC_AUTH_TOKEN")).toBe("gateway");
    expect(tokenKindOf("OPENAI_API_KEY")).toBe("gateway");
    expect(tokenKindOf("DATABASE_URL")).toBeNull();
  });

  it("by default the agent keys are an agent's own; ANTHROPIC_AUTH_TOKEN is always a gateway's", () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "");
    expect(tokenKindOf("ANTHROPIC_API_KEY")).toBe("agent");
    expect(tokenKindOf("OPENAI_API_KEY")).toBe("agent");
    expect(tokenKindOf("ANTHROPIC_AUTH_TOKEN")).toBe("gateway");
  });

  it("records a team's token with its team, a person's without one, other secrets not at all", async () => {
    await auditTokenSecret(req(), "set", {
      name: "ANTHROPIC_AUTH_TOKEN",
      scope: "team",
      teamId: "t-1",
    });
    await auditTokenSecret(req(), "delete", { name: "GITLAB_TOKEN", scope: "user", teamId: "t-1" });
    await auditTokenSecret(req(), "set", { name: "SOME_SECRET", scope: "global" });
    expect(written().map((w) => [w.action, w.params])).toEqual([
      ["gateway.token.set", { name: "ANTHROPIC_AUTH_TOKEN", scope: "team", teamId: "t-1" }],
      ["gitlab.token.delete", { name: "GITLAB_TOKEN", scope: "user" }],
    ]);
  });

  it("names whose personal token it was when that isn't the caller", async () => {
    await auditTokenSecret(req(), "delete", {
      name: "GITLAB_TOKEN",
      scope: "user",
      targetUserId: "u-2",
    });
    await auditTokenSecret(req(), "delete", {
      name: "GITLAB_TOKEN",
      scope: "user",
      targetUserId: "u-1",
    });
    await auditTokenSecret(req(), "delete", {
      name: "GITLAB_TOKEN",
      scope: "global",
      targetUserId: "u-2",
    });
    expect(written().map((w) => w.params)).toEqual([
      { name: "GITLAB_TOKEN", scope: "user", targetUserId: "u-2" },
      { name: "GITLAB_TOKEN", scope: "user" },
      { name: "GITLAB_TOKEN", scope: "global" },
    ]);
  });
});

describe("ownerDetails", () => {
  it("says whose a resource is, naming another person", () => {
    expect(ownerDetails(req(), { ownerUserId: null, ownerTeamId: null })).toEqual({
      scope: "workspace",
    });
    expect(ownerDetails(req(), { ownerUserId: null, ownerTeamId: "t-1" })).toEqual({
      scope: "team",
      teamId: "t-1",
    });
    expect(ownerDetails(req(), { ownerUserId: "u-1" })).toEqual({
      scope: "user",
      targetUserId: undefined,
    });
    expect(ownerDetails(req(), { ownerUserId: "u-2" })).toEqual({
      scope: "user",
      targetUserId: "u-2",
    });
  });
});

describe("auditAutoMergeSetting", () => {
  const target = { type: "repo" as const, id: "r-1" };

  it("records a confirmation, and turning it off a row that had it on", async () => {
    await auditAutoMergeSetting(req(), { autoMerge: true, autoMergeConfirmed: true }, target);
    await auditAutoMergeSetting(req(), { autoMerge: false }, target, { autoMerge: true });
    expect(written().map((w) => [w.action, w.params])).toEqual([
      ["auto_merge.confirm", { type: "repo", id: "r-1" }],
      ["auto_merge.off", { type: "repo", id: "r-1" }],
    ]);
  });

  it("records nothing for an unconfirmed ask, a row that was off, or a write that leaves it", async () => {
    await auditAutoMergeSetting(req(), { autoMerge: true }, target);
    await auditAutoMergeSetting(req(), { autoMerge: false }, target, { autoMerge: false });
    await auditAutoMergeSetting(req(), { autoMerge: false }, target);
    await auditAutoMergeSetting(req(), {}, target, { autoMerge: true });
    expect(logAction).not.toHaveBeenCalled();
  });

  it("reads a WorkSpec the way work-write-service does", () => {
    expect(
      workSpecAutoMerge({ then: "until-merged", mergeWhenReady: true, autoMergeConfirmed: true }),
    ).toEqual({ autoMerge: true, autoMergeConfirmed: true });
    expect(workSpecAutoMerge({ then: "until-merged" })).toEqual({
      autoMerge: false,
      autoMergeConfirmed: undefined,
    });
    // Another Then clears merging on the definition (followThrough): it is off.
    expect(workSpecAutoMerge({ then: "exits", mergeWhenReady: true })).toEqual({
      autoMerge: false,
      autoMergeConfirmed: undefined,
    });
  });

  it("records turning merging off on work by changing its Then", async () => {
    await auditAutoMergeSetting(
      req(),
      workSpecAutoMerge({ then: "exits" }),
      { type: "work", id: "w-1" },
      { autoMerge: true },
    );
    expect(written().map((w) => [w.action, w.params])).toEqual([
      ["auto_merge.off", { type: "work", id: "w-1" }],
    ]);
  });
});

describe("who reads which actions", () => {
  const dialect = new PgDialect();
  const text = (q: SQL) => dialect.sqlToQuery(q);

  it("keeps merges and sign-ins from members", () => {
    const q = text(notAdminOnlyAction(sql`a`));
    expect(q.params).toEqual(expect.arrayContaining(["pr.merge", "auto_merge", "auth"]));
  });

  it("keeps rows without a workspace and a deployment-wide action from workspace admins", () => {
    const q = text(notDeploymentWideAction(sql`ws`, sql`a`));
    expect(q.sql).toMatch(/^NOT \(ws IS NULL AND \(/);
    expect(q.params).toEqual(expect.arrayContaining(["auth", "sign_in", "sign\\_in.%"]));
  });
});

describe("likeSubActions", () => {
  it("takes underscores and percent signs literally", () => {
    expect(likeSubActions("api_key")).toBe("api\\_key.%");
    expect(likeSubActions("a%b")).toBe("a\\%b.%");
  });
});
