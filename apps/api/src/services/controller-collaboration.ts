/** A common address and inbox for persistent agents and active pod runs.
 * Persistent agents wake on delivery. Runs read durable messages through MCP;
 * sending one never replays a finished run or assumes a runtime supports stdin.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { buildSenderId } from "@optio/shared";
import { db } from "../db/client.js";
import {
  persistentAgents,
  persistentAgentMessages,
  taskMessages,
  users,
  workDefinitions,
  workRuns,
} from "../db/schema.js";
import type { ControllerPrincipal } from "./controller-auth.js";
import { ControllerError, requireChange, requireVisible, tenant } from "./controller-access.js";
import { canUse } from "./ownership.js";
import { visibleWork } from "./work-visibility.js";
import * as pa from "./persistent-agent-service.js";
import { publishEvent } from "./event-bus.js";

const activeStates: Array<typeof workRuns.$inferSelect.state> = ["provisioning", "running"];
const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const ownAddress = (p: ControllerPrincipal) => p.run?.agentId ?? p.run?.id ?? null;

function effectiveRun(
  row: typeof workRuns.$inferSelect,
  definition: typeof workDefinitions.$inferSelect | null,
) {
  if (row.kind === "standalone") {
    if (
      !definition ||
      definition.workspaceId !== row.workspaceId ||
      definition.ownerUserId !== row.ownerUserId
    )
      return { runtime: null, access: "off", name: row.title ?? "Job run" };
    return {
      runtime: definition.agentType,
      access: definition.settings?.controllerAccess ?? "off",
      name: row.title ?? definition.name,
    };
  }
  return {
    runtime: row.agentType,
    access: row.settings?.controllerAccess ?? "off",
    name: row.title ?? "Task",
  };
}
function acceptingRun(row: typeof workRuns.$inferSelect, access: string, runtime: string | null) {
  return (
    !!runtime &&
    row.runTarget === "cluster" &&
    row.taskType === "coding" &&
    activeStates.includes(row.state) &&
    !row.controlIntent &&
    !row.recoveryRequired &&
    row.execState !== "exited" &&
    ["read", "manage"].includes(access)
  );
}

/** Recognize addresses emitted by earlier controller versions as well as UUIDs. */
function normalizeAddress(p: ControllerPrincipal, address: string) {
  if (address.startsWith("work/") && isUuid(address.slice(5))) return address.slice(5);
  const prefix = `agent:${p.actor.workspaceId ?? "default"}/`;
  if (address.startsWith(prefix)) return address.slice(prefix.length);
  return address;
}

async function participant(p: ControllerPrincipal, address: string) {
  const to = normalizeAddress(p, address);
  if (isUuid(to)) {
    const [found] = await db
      .select({ row: workRuns, definition: workDefinitions })
      .from(workRuns)
      .leftJoin(workDefinitions, eq(workRuns.workId, workDefinitions.id))
      .where(eq(workRuns.id, to));
    if (found) {
      requireVisible(p, found.row);
      return { kind: "run" as const, ...found, ...effectiveRun(found.row, found.definition) };
    }
  }
  const agent = isUuid(to)
    ? await pa.getPersistentAgentUnscoped(to)
    : await pa.getPersistentAgentBySlug(p.actor.workspaceId, to);
  requireVisible(p, agent);
  return { kind: "agent" as const, row: agent! };
}

export async function listControllerAgents(
  p: ControllerPrincipal,
  input: {
    limit: number;
    offset: number;
    search?: string;
    kind?: "persistent-agent" | "repo-task" | "job-run";
    runtime?: string;
  },
) {
  const cap = input.offset + input.limit + 1;
  const search = (field: Parameters<typeof ilike>[0]) =>
    input.search ? ilike(field, `%${input.search}%`) : undefined;
  // Effective runtime and access come from the definition for Job runs.
  const runtime = sql<string>`CASE WHEN ${workRuns.kind} = 'standalone' THEN ${workDefinitions.agentType} ELSE ${workRuns.agentType} END`;
  const access = sql<string>`CASE WHEN ${workRuns.kind} = 'standalone' THEN ${workDefinitions.settings}->>'controllerAccess' ELSE ${workRuns.settings}->>'controllerAccess' END`;
  const [agents, runs] = await Promise.all([
    !input.kind || input.kind === "persistent-agent"
      ? db
          .select()
          .from(persistentAgents)
          .where(
            and(
              tenant(persistentAgents.workspaceId, p.actor.workspaceId),
              visibleWork(
                persistentAgents.ownerUserId,
                persistentAgents.ownerTeamId,
                persistentAgents.createdBy,
                p.actor,
              ),
              or(search(persistentAgents.name), search(persistentAgents.slug)),
              input.runtime ? eq(persistentAgents.agentRuntime, input.runtime) : undefined,
            ),
          )
          .orderBy(desc(persistentAgents.createdAt), desc(persistentAgents.id))
          .limit(cap)
      : [],
    input.kind !== "persistent-agent"
      ? db
          .select({ row: workRuns, definition: workDefinitions })
          .from(workRuns)
          .leftJoin(workDefinitions, eq(workRuns.workId, workDefinitions.id))
          .where(
            and(
              tenant(workRuns.workspaceId, p.actor.workspaceId),
              visibleWork(workRuns.ownerUserId, workRuns.ownerTeamId, workRuns.createdBy, p.actor),
              eq(workRuns.runTarget, "cluster"),
              eq(workRuns.taskType, "coding"),
              inArray(workRuns.state, activeStates),
              isNull(workRuns.controlIntent),
              eq(workRuns.recoveryRequired, false),
              sql`${workRuns.execState} IS DISTINCT FROM 'exited'`,
              sql`${runtime} IS NOT NULL`,
              sql`${access} IN ('read', 'manage')`,
              sql`(${workRuns.kind} <> 'standalone' OR (${workDefinitions.workspaceId} IS NOT DISTINCT FROM ${workRuns.workspaceId} AND ${workDefinitions.ownerUserId} IS NOT DISTINCT FROM ${workRuns.ownerUserId}))`,
              input.kind
                ? eq(workRuns.kind, input.kind === "repo-task" ? "repo" : "standalone")
                : undefined,
              input.runtime ? eq(runtime, input.runtime) : undefined,
              or(search(workRuns.title), search(workDefinitions.name)),
            ),
          )
          .orderBy(desc(workRuns.createdAt), desc(workRuns.id))
          .limit(cap)
      : [],
  ]);
  const rows = [
    ...agents.map((a) => ({
      id: a.id,
      address: a.id,
      kind: "agent",
      source: "persistent-agent",
      name: a.name,
      slug: a.slug,
      agentRuntime: a.agentRuntime,
      state: a.state,
      enabled: a.enabled,
      ownerUserId: a.ownerUserId,
      controllerAccess: a.settings?.controllerAccess ?? "off",
      delivery: "wake",
      href: `/agents/${a.id}`,
      canMessage:
        p.access === "manage" &&
        a.id !== ownAddress(p) &&
        a.enabled &&
        !a.controlIntent &&
        !["archived", "paused"].includes(a.state) &&
        canUse(a.ownerUserId, p.actor.userId),
      createdAt: a.createdAt,
    })),
    ...runs.map(({ row, definition }) => {
      const info = effectiveRun(row, definition);
      return {
        id: row.id,
        address: row.id,
        kind: "run",
        source: row.kind === "repo" ? "repo-task" : "job-run",
        name: info.name,
        agentRuntime: info.runtime,
        state: row.state,
        ownerUserId: row.ownerUserId,
        controllerAccess: info.access,
        delivery: "inbox",
        href: row.kind === "repo" ? `/tasks/${row.id}` : `/jobs/${row.workId}/runs/${row.id}`,
        canMessage:
          p.access === "manage" &&
          row.id !== ownAddress(p) &&
          canUse(row.ownerUserId, p.actor.userId),
        createdAt: row.createdAt,
      };
    }),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
  return {
    rows: rows.slice(input.offset, input.offset + input.limit),
    nextOffset: rows.length > input.offset + input.limit ? input.offset + input.limit : null,
  };
}

export async function controllerInbox(
  p: ControllerPrincipal,
  address: string | undefined,
  limit: number,
  offset: number,
) {
  const to = address ?? ownAddress(p);
  if (!to)
    throw new ControllerError(400, "Specify an agent address, run id or persistent-agent slug");
  const target = await participant(p, to);
  if (target.kind === "agent") {
    const rows = await db
      .select()
      .from(persistentAgentMessages)
      .where(eq(persistentAgentMessages.agentId, target.row.id))
      .orderBy(desc(persistentAgentMessages.receivedAt), desc(persistentAgentMessages.id))
      .limit(limit + 1)
      .offset(offset);
    return {
      agentId: target.row.id,
      messages: rows.slice(0, limit).map((row) => ({
        ...row,
        replyTo:
          row.senderType === "agent" && row.senderId ? normalizeAddress(p, row.senderId) : null,
      })),
      nextOffset: rows.length > limit ? offset + limit : null,
    };
  }
  const rows = await db
    .select({ message: taskMessages, userName: users.displayName })
    .from(taskMessages)
    .leftJoin(users, eq(taskMessages.userId, users.id))
    .where(eq(taskMessages.taskId, target.row.id))
    .orderBy(desc(taskMessages.createdAt), desc(taskMessages.id))
    .limit(limit + 1)
    .offset(offset);
  return {
    agentId: target.row.id,
    messages: rows.slice(0, limit).map(({ message: m, userName }) => ({
      id: m.id,
      body: m.content,
      senderType: m.senderType,
      senderName: m.senderName ?? userName,
      senderId: m.senderAddress ?? m.userId,
      replyTo: m.senderType === "agent" ? m.senderAddress : null,
      receivedAt: m.createdAt,
    })),
    nextOffset: rows.length > limit ? offset + limit : null,
  };
}

export async function sendControllerMessage(p: ControllerPrincipal, address: string, body: string) {
  const target = await participant(p, address);
  requireChange(p, target.row);
  if (target.row.id === ownAddress(p)) throw new ControllerError(400, "Cannot message self");
  if (target.kind === "agent") {
    const a = target.row;
    if (!a.enabled || a.controlIntent || ["archived", "paused"].includes(a.state))
      throw new ControllerError(409, "Recipient is paused or disabled");
    const messageId = randomUUID();
    await pa.wakeAgent({
      messageId,
      agentId: a.id,
      source: p.run ? "agent" : "user",
      body,
      senderType: p.run ? "agent" : "user",
      senderName: p.name,
      senderId: p.run?.slug
        ? buildSenderId({ type: "agent", workspaceId: p.actor.workspaceId, slug: p.run.slug })
        : p.run
          ? `work/${p.run.id}`
          : p.actor.userId,
    });
    return { messageId, agentId: a.id, to: a.slug, status: "queued", delivery: "wake" };
  }
  if (!acceptingRun(target.row, target.access, target.runtime))
    throw new ControllerError(
      409,
      "Recipient must be an active pod agent run with controller access enabled",
    );
  // Serialize acceptance with state changes; a run that finished first cannot
  // receive a new message. Reading an inbox does not claim it was acted on.
  const message = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(workRuns)
      .where(eq(workRuns.id, target.row.id))
      .for("update");
    if (!current || !acceptingRun(current, target.access, target.runtime))
      throw new ControllerError(409, "Recipient is no longer active");
    requireChange(p, current);
    const [m] = await tx
      .insert(taskMessages)
      .values({
        taskId: current.id,
        workspaceId: current.workspaceId,
        userId: p.run ? null : p.actor.userId,
        content: body,
        mode: "soft",
        senderType: p.run ? "agent" : "user",
        senderName: p.name,
        senderAddress: ownAddress(p),
      })
      .returning();
    await tx
      .update(workRuns)
      .set({ lastMessageAt: m.createdAt })
      .where(eq(workRuns.id, current.id));
    return m;
  });
  if (target.row.kind === "repo")
    await publishEvent({
      type: "task:message",
      taskId: target.row.id,
      messageId: message.id,
      userId: message.userId,
      userDisplayName: p.run ? null : p.name,
      content: body,
      mode: "soft",
      createdAt: message.createdAt.toISOString(),
      senderType: message.senderType,
      senderName: message.senderName,
      senderAddress: message.senderAddress,
    });
  return {
    messageId: message.id,
    agentId: target.row.id,
    to: target.row.id,
    status: "queued",
    delivery: "inbox",
  };
}
