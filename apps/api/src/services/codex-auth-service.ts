import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { codexAuthAccounts, repoPods } from "../db/schema.js";
import { createSession, getSession } from "./interactive-session-service.js";
import { getRuntime } from "./container-service.js";
import { retrieveSecretWithFallback, storeSecret } from "./secret-service.js";
import type { ContainerHandle, ExecSession } from "@optio/shared";

function workspaceCondition(workspaceId?: string | null) {
  return workspaceId
    ? eq(codexAuthAccounts.workspaceId, workspaceId)
    : isNull(codexAuthAccounts.workspaceId);
}

async function collectExecOutput(
  session: ExecSession,
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];

  const stdoutDone = new Promise<void>((resolve) => {
    session.stdout.on("data", (chunk: Buffer | string) => {
      stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    session.stdout.on("end", resolve);
  });

  const stderrDone = new Promise<void>((resolve) => {
    session.stderr.on("data", (chunk: Buffer | string) => {
      stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    session.stderr.on("end", resolve);
  });

  await Promise.all([stdoutDone, stderrDone]);
  return {
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderr: Buffer.concat(stderrChunks).toString("utf8"),
  };
}

export async function getCodexAuthAccount(workspaceId?: string | null) {
  const [account] = await db
    .select()
    .from(codexAuthAccounts)
    .where(and(eq(codexAuthAccounts.name, "default"), workspaceCondition(workspaceId)));
  return account ?? null;
}

export async function upsertCodexAuthAccount(input: {
  workspaceId?: string | null;
  userId?: string | null;
  appServerUrl: string;
  authJson?: string;
}) {
  const existing = await getCodexAuthAccount(input.workspaceId);
  const now = new Date();
  const trimmedAuthJson = input.authJson?.trim();

  if (trimmedAuthJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmedAuthJson);
    } catch {
      throw new Error("Codex auth JSON must be valid JSON");
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Codex auth JSON must be a JSON object");
    }
    await storeSecret("CODEX_AUTH_JSON", JSON.stringify(parsed), "global");
  }

  const values = {
    workspaceId: input.workspaceId ?? null,
    name: "default",
    appServerUrl: input.appServerUrl,
    status: (trimmedAuthJson ? "connected" : (existing?.status ?? "pending")) as
      | "pending"
      | "connected"
      | "error",
    createdBy: input.userId ?? existing?.createdBy ?? null,
    lastImportedAt: trimmedAuthJson ? now : (existing?.lastImportedAt ?? null),
    lastValidatedAt: trimmedAuthJson ? now : (existing?.lastValidatedAt ?? null),
    lastError: null,
    updatedAt: now,
  };

  if (existing) {
    const [updated] = await db
      .update(codexAuthAccounts)
      .set(values)
      .where(eq(codexAuthAccounts.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await db.insert(codexAuthAccounts).values(values).returning();
  return created;
}

export async function getCodexAppServerConfig(opts: {
  workspaceId?: string | null;
  userId?: string | null;
}) {
  const account = await getCodexAuthAccount(opts.workspaceId);
  const codexAuthJson = (await retrieveSecretWithFallback(
    "CODEX_AUTH_JSON",
    "global",
    opts.workspaceId,
    opts.userId,
  ).catch(() => null)) as string | null;
  const legacyUrl = (await retrieveSecretWithFallback(
    "CODEX_APP_SERVER_URL",
    "global",
    opts.workspaceId,
    opts.userId,
  ).catch(() => null)) as string | null;

  return {
    appServerUrl: account?.appServerUrl ?? legacyUrl ?? undefined,
    codexAuthJson: codexAuthJson ?? undefined,
    account,
  };
}

export async function startCodexAuthSession(input: {
  workspaceId?: string | null;
  userId?: string;
  repoUrl: string;
  appServerUrl: string;
}) {
  const session = await createSession({
    repoUrl: input.repoUrl,
    userId: input.userId,
    workspaceId: input.workspaceId,
  });

  const existing = await getCodexAuthAccount(input.workspaceId);
  const values = {
    workspaceId: input.workspaceId ?? null,
    name: "default",
    appServerUrl: input.appServerUrl,
    status: "pending" as const,
    loginSessionId: session.id,
    loginSessionRepoUrl: input.repoUrl,
    createdBy: input.userId ?? null,
    lastError: null,
    updatedAt: new Date(),
  };

  if (existing) {
    const [updated] = await db
      .update(codexAuthAccounts)
      .set(values)
      .where(eq(codexAuthAccounts.id, existing.id))
      .returning();
    return { account: updated, session };
  }

  const [created] = await db.insert(codexAuthAccounts).values(values).returning();
  return { account: created, session };
}

async function resolveSessionPodHandle(sessionId: string, userId?: string) {
  const session = await getSession(sessionId);
  if (!session) throw new Error("Session not found");
  if (session.userId && userId && session.userId !== userId) throw new Error("Session not found");
  if (!session.podId) throw new Error("Session has no pod assigned");

  const [pod] = await db.select().from(repoPods).where(eq(repoPods.id, session.podId));
  if (!pod?.podName) throw new Error("Session pod is no longer available");

  const handle: ContainerHandle = {
    id: pod.podId ?? pod.podName,
    name: pod.podName,
  };
  return { session, handle };
}

export async function importCodexAuthFromSession(input: {
  workspaceId?: string | null;
  userId?: string;
  sessionId?: string;
}) {
  const account = await getCodexAuthAccount(input.workspaceId);
  const sessionId = input.sessionId ?? account?.loginSessionId ?? undefined;
  if (!sessionId) {
    throw new Error("No Codex login session is registered");
  }

  const { handle } = await resolveSessionPodHandle(sessionId, input.userId);
  const exec = await getRuntime().exec(
    handle,
    [
      "bash",
      "-lc",
      [
        "set -euo pipefail",
        'test -s /home/agent/.codex/auth.json || { echo "Codex login has not completed in this session yet." >&2; exit 44; }',
        "cat /home/agent/.codex/auth.json",
      ].join("\n"),
    ],
    { tty: false },
  );

  const result = await collectExecOutput(exec);
  if (!result.stdout.trim()) {
    throw new Error(result.stderr.trim() || "Failed to read Codex auth from session");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("Session produced an invalid Codex auth.json");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Session produced an invalid Codex auth.json");
  }

  await storeSecret("CODEX_AUTH_JSON", JSON.stringify(parsed), "global");

  if (account) {
    await db
      .update(codexAuthAccounts)
      .set({
        status: "connected",
        lastImportedAt: new Date(),
        lastValidatedAt: new Date(),
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(codexAuthAccounts.id, account.id));
  }
}
