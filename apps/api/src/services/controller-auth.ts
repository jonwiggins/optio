/** Credentials for the controller MCP and the legacy inter-agent HTTP API.
 * Run credentials are never user sessions. They are usable only here, expire
 * after 24 hours, and are checked against the live run on every request.
 * Redis keeps the current grant per attempt, so issuing a new one invalidates
 * the previous attempt even if that run is resumed within the expiry window.
 */
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client.js";
import { workRuns, workDefinitions, interactiveSessions, sessionChatTurns } from "../db/schema.js";
import { getRedisClient } from "./event-bus.js";
import { getPersistentAgentTurn, getPersistentAgentUnscoped } from "./persistent-agent-service.js";
import { validateApiKey } from "./api-key-service.js";
import { getUserRole } from "./workspace-service.js";
import { teamMembershipsOf } from "./team-service.js";
import { getWorkVisibility } from "./work-visibility.js";
import { isAuthDisabled } from "./oauth/index.js";
import type { Actor } from "./ownership.js";

export interface ControllerPrincipal {
  actor: Actor;
  access: "read" | "manage";
  name: string;
  sessionPolicy?: { confirmWrites: boolean; enabledTools: string[] };
  run?: {
    kind: "work-run" | "turn" | "session-turn";
    sessionId?: string;
    id: string;
    agentId?: string;
    slug?: string;
  };
}

const Grant = z
  .object({
    kind: z.enum(["work-run", "turn", "session-turn"]),
    id: z.string().uuid(),
    workspaceId: z.string().uuid().nullable(),
    ownerUserId: z.string().uuid().nullable(),
    access: z.enum(["read", "manage", "messages"]),
    nonce: z.string().uuid(),
    exp: z.number().int(),
  })
  .strict();
type Grant = z.infer<typeof Grant>;
const TTL = 24 * 60 * 60;
const PREFIX = "optio_run_";
const key = (g: Pick<Grant, "kind" | "id" | "access">) =>
  `optio:controller-grant:${g.kind}:${g.id}:${g.access === "messages" ? "messages" : "mcp"}`;

function signature(body: string): Buffer {
  const root = process.env.OPTIO_ENCRYPTION_KEY;
  if (!root) throw new Error("OPTIO_ENCRYPTION_KEY required for controller credentials");
  return createHmac("sha256", root).update(`optio-controller:v1:${body}`).digest();
}

export async function issueControllerToken(input: Omit<Grant, "nonce" | "exp">): Promise<string> {
  const grant: Grant = { ...input, nonce: randomUUID(), exp: Math.floor(Date.now() / 1000) + TTL };
  const body = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const token = `${PREFIX}${body}.${signature(body).toString("base64url")}`;
  await getRedisClient().set(key(grant), grant.nonce, "EX", TTL);
  return token;
}

/** Pure verification before touching Redis or the database. */
export function parseControllerToken(token: string): Grant | null {
  if (!token.startsWith(PREFIX) || token.length > 2048) return null;
  try {
    const parts = token.slice(PREFIX.length).split(".");
    if (parts.length !== 2) return null;
    const actual = Buffer.from(parts[1], "base64url");
    const expected = signature(parts[0]);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const g = Grant.parse(JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")));
    return g.exp > Math.floor(Date.now() / 1000) ? g : null;
  } catch {
    return null;
  }
}

export async function validateControllerToken(
  token: string,
  purpose: "mcp" | "messages" = "mcp",
): Promise<ControllerPrincipal | null> {
  const g = parseControllerToken(token);
  if (!g || (g.access === "messages") !== (purpose === "messages")) return null;
  if ((await getRedisClient().get(key(g))) !== g.nonce) return null;
  let owner: string | null;
  let workspace: string | null;
  let settings: { controllerAccess?: string } | null;
  let name: string;
  let sessionPolicy: ControllerPrincipal["sessionPolicy"];
  let run: NonNullable<ControllerPrincipal["run"]> = { kind: g.kind, id: g.id };
  if (g.kind === "session-turn") {
    if (purpose === "messages") return null;
    const [turn] = await db.select().from(sessionChatTurns).where(eq(sessionChatTurns.id, g.id));
    if (!turn || turn.state !== "running" || turn.finishedAt) return null;
    const [session] = await db
      .select()
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, turn.sessionId));
    if (!session || session.state !== "active" || !session.agentRuntime) return null;
    owner = session.userId;
    workspace = session.workspaceId;
    settings = session.settings;
    name = session.title ?? "Interactive session";
    const { getSettings } = await import("./optio-settings-service.js");
    const policy = session.assistant ? await getSettings(workspace) : null;
    sessionPolicy = {
      confirmWrites: policy?.confirmWrites ?? true,
      enabledTools: policy?.enabledTools ?? [],
    };
    run = { ...run, sessionId: session.id };
  } else if (g.kind === "turn") {
    const turn = await getPersistentAgentTurn(g.id);
    if (!turn || turn.finishedAt || turn.haltReason || turn.execState === "exited") return null;
    const agent = await getPersistentAgentUnscoped(turn.agentId);
    if (
      !agent ||
      !agent.enabled ||
      agent.controlIntent ||
      !["running", "provisioning"].includes(agent.state)
    )
      return null;
    owner = agent.ownerUserId;
    workspace = agent.workspaceId;
    settings = agent.settings;
    name = agent.name;
    run = { ...run, agentId: agent.id, slug: agent.slug };
  } else {
    if (purpose === "messages") return null;
    const [row] = await db.select().from(workRuns).where(eq(workRuns.id, g.id));
    if (
      !row ||
      row.controlIntent ||
      row.recoveryRequired ||
      row.execState === "exited" ||
      !["running", "provisioning"].includes(row.state) ||
      row.taskType !== "coding"
    )
      return null;
    owner = row.ownerUserId;
    workspace = row.workspaceId;
    name = row.title ?? "Optio work";
    settings = row.settings;
    if (row.kind === "standalone") {
      if (!row.workId) return null;
      const [definition] = await db
        .select()
        .from(workDefinitions)
        .where(eq(workDefinitions.id, row.workId));
      if (!definition || definition.workspaceId !== workspace || definition.ownerUserId !== owner)
        return null;
      settings = definition.settings;
      name = row.title ?? definition.name;
    }
  }
  if (workspace !== g.workspaceId || owner !== g.ownerUserId) return null;
  if (
    purpose === "mcp" &&
    settings?.controllerAccess !== "manage" &&
    settings?.controllerAccess !== g.access
  )
    return null;
  // A removed member or a newly read-only owner cannot keep delegating writes.
  if (owner && workspace) {
    const role = await getUserRole(workspace, owner);
    if (!role || role === "viewer") return null;
  }
  return {
    actor: await fullActor(owner, workspace, false),
    access: g.access === "read" ? "read" : "manage",
    name,
    run,
    sessionPolicy,
  };
}

/**
 * An Actor with what the auth plugin would put on a request: the person's
 * teams in the workspace and its work-visibility mode — so the controller
 * sees team work and hides what the mode hides, like the HTTP routes.
 */
async function fullActor(
  userId: string | null,
  workspaceId: string | null,
  isAdmin: boolean,
): Promise<Actor> {
  const mine = userId && workspaceId ? await teamMembershipsOf(userId, workspaceId) : [];
  return {
    userId,
    workspaceId,
    isAdmin,
    teamIds: mine.map((m) => m.teamId),
    adminTeamIds: mine.filter((m) => m.role === "admin").map((m) => m.teamId),
    workVisibility: await getWorkVisibility(workspaceId),
  };
}

/** PATs use the caller's current workspace role; a run can never pick its workspace. */
export async function authenticateController(
  authorization: string | undefined,
  workspaceId?: string,
): Promise<ControllerPrincipal | null> {
  if (!authorization) {
    return isAuthDisabled() && !workspaceId
      ? {
          actor: { userId: null, workspaceId: null, isAdmin: true },
          access: "manage",
          name: "Local operator",
        }
      : null;
  }
  if (!authorization.startsWith("Bearer ")) return null;
  const token = authorization.slice(7);
  if (token.startsWith(PREFIX)) {
    const principal = await validateControllerToken(token);
    if (workspaceId && principal?.actor.workspaceId !== workspaceId) return null;
    return principal;
  }
  const user = await validateApiKey(token);
  if (!user) return null;
  const ws = workspaceId ?? user.workspaceId;
  if (!ws || !z.string().uuid().safeParse(ws).success) return null;
  const role = await getUserRole(ws, user.id);
  if (!role) return null;
  return {
    actor: await fullActor(user.id, ws, role === "admin"),
    access: role === "viewer" ? "read" : "manage",
    name: user.displayName,
  };
}
