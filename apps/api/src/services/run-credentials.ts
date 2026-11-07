import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { and, desc, eq, gte, lte, type SQL } from "drizzle-orm";
import { parseRepoUrl } from "@optio/shared";
import { db } from "../db/client.js";
import { runCredentials, users, workspaces } from "../db/schema.js";
import { logger } from "../logger.js";

/**
 * Which credentials each run was given, so that after a token or key leaks
 * an admin can list the work that used it (Settings → Access → Credential
 * use, `POST /api/credential-use/search`).
 *
 * A run's processing goes inside `withRunCredentials`; once the run is
 * known, `attributeRunCredentials` names it. Every credential the code
 * resolves in between — a stored secret (`retrieveSecret`, an agent
 * credential by id), a GitHub App installation token, a model provider, a
 * token from the API's environment — reports itself with
 * `noteCredentialUse`, and lands in `run_credentials` as an identity: kind,
 * scope, name, the stored row's id, the host, and a fingerprint. Never the
 * value. Lookups that miss are not recorded, only what was found.
 *
 * The fingerprint is HMAC-SHA-256 of the value under a key derived from
 * OPTIO_ENCRYPTION_KEY, first 16 hex digits. Keyed, so a copy of the
 * database alone can't be used to test guesses at a weak secret; an admin
 * matches a leaked value by pasting it into the search, which hashes it the
 * same way and keeps nothing.
 *
 * Recording is opt-in with `OPTIO_RECORD_RUN_CREDENTIALS=true` (identities
 * only, one small insert per credential per run); off by default.
 * A failed insert is logged and never fails the run.
 */

export const RUN_KINDS = ["task", "job-run", "review", "agent-turn", "session"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export const CREDENTIAL_KINDS = [
  "git-token",
  "model-key",
  "secret",
  "github-app",
  "model-provider",
] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
export const CREDENTIAL_SCOPES = [
  "personal",
  "workspace",
  "deployment",
  "repo",
  "environment",
] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

export interface RunRef {
  kind: RunKind;
  id: string;
  workspaceId: string | null;
  /** Whose work it is (null for the organization's). */
  userId: string | null;
  repoUrl?: string | null;
}

export interface CredentialUse {
  kind: CredentialKind;
  scope: CredentialScope;
  name: string;
  credentialId?: string | null;
  host?: string | null;
  /** Only to compute the fingerprint; dropped right away. */
  value?: string | null;
}

type Noted = Omit<CredentialUse, "value"> & { fingerprint: string | null };

export function runCredentialRecordingEnabled(): boolean {
  return process.env.OPTIO_RECORD_RUN_CREDENTIALS?.trim().toLowerCase() === "true";
}

/**
 * The fingerprint of a credential value (16 hex), or null without an
 * encryption key. Surrounding whitespace is ignored, so a value pasted with
 * a trailing newline matches.
 */
export function credentialFingerprint(value: string): string | null {
  const key = process.env.OPTIO_ENCRYPTION_KEY;
  const v = value.trim();
  if (!key || !v) return null;
  return createHmac("sha256", key)
    .update(`optio-credential-fingerprint:v1:${v}`)
    .digest("hex")
    .slice(0, 16);
}

class Recorder {
  run: RunRef | null = null;
  private seen = new Set<string>();
  private pending: Noted[] = [];
  private writes: Promise<void>[] = [];

  note(use: Noted): void {
    const key = [use.kind, use.scope, use.name, use.credentialId ?? "", use.fingerprint ?? ""].join(
      "\u0000",
    );
    if (this.seen.has(key)) return;
    this.seen.add(key);
    if (this.run) this.write([use]);
    else this.pending.push(use);
  }

  attribute(run: RunRef): void {
    this.run = { ...this.run, ...run };
    const pending = this.pending;
    this.pending = [];
    if (pending.length > 0) this.write(pending);
  }

  private write(uses: Noted[]): void {
    const run = this.run!;
    const rows = uses.map((u) => ({
      runKind: run.kind,
      runId: run.id,
      workspaceId: run.workspaceId,
      userId: run.userId,
      repoUrl: run.repoUrl ?? null,
      kind: u.kind,
      scope: u.scope,
      name: u.name,
      credentialId: u.credentialId ?? null,
      host: u.host ?? gitHost(u, run.repoUrl ?? null),
      fingerprint: u.fingerprint,
    }));
    this.writes.push(
      db
        .insert(runCredentials)
        .values(rows)
        .then(() => undefined)
        .catch((err) => {
          logger.warn(
            { err, runKind: run.kind, runId: run.id },
            "Failed to record the credentials a run used",
          );
        }),
    );
  }

  async settle(): Promise<void> {
    await Promise.all(this.writes);
  }
}

/** The run's repo host, for a git credential of that repo's platform. */
function gitHost(use: Noted, repoUrl: string | null): string | null {
  if (!repoUrl || (use.kind !== "git-token" && use.kind !== "github-app")) return null;
  const repo = parseRepoUrl(repoUrl);
  if (!repo) return null;
  const github = use.kind === "github-app" || use.name.startsWith("GITHUB_");
  const gitlab = use.name.startsWith("GITLAB_");
  if ((repo.platform === "github" && github) || (repo.platform === "gitlab" && gitlab))
    return repo.host;
  return null;
}

const store = new AsyncLocalStorage<Recorder>();

/**
 * Run `fn` with credential recording: what it resolves is recorded for the
 * run `attributeRunCredentials` names inside it (nothing, if it names none:
 * the run never started). Waits for the records to be written.
 */
export async function withRunCredentials<T>(fn: () => Promise<T>): Promise<T> {
  if (!runCredentialRecordingEnabled()) return fn();
  const recorder = new Recorder();
  return store.run(recorder, async () => {
    try {
      return await fn();
    } finally {
      await recorder.settle();
    }
  });
}

/** A processor wrapped in `withRunCredentials`. */
export function recordingRunCredentials<A extends unknown[], T>(
  fn: (...args: A) => Promise<T>,
): (...args: A) => Promise<T> {
  return (...args: A) => withRunCredentials(() => fn(...args));
}

/**
 * Name the run whose credentials are being resolved: what was noted so far
 * and everything noted from here on is recorded for it. Calling it again
 * updates the run's details (a repo found later) for what comes after.
 */
export function attributeRunCredentials(run: RunRef): void {
  store.getStore()?.attribute(run);
}

/** Whether credentials resolved here are being recorded for a run. */
export function recordingCredentials(): boolean {
  return store.getStore() !== undefined;
}

/** Report a credential handed to the current run (a no-op outside one). */
export function noteCredentialUse(use: CredentialUse): void {
  const recorder = store.getStore();
  if (!recorder) return;
  const { value, ...identity } = use;
  recorder.note({ ...identity, fingerprint: value ? credentialFingerprint(value) : null });
}

/** Names read as secrets that only configure Optio; not credentials. */
function notACredential(name: string): boolean {
  return (
    /_AUTH_MODE$/.test(name) ||
    /_(HOST|HOSTS|REGION|EXPIRES_AT)$/.test(name) ||
    name.startsWith("CLAUDE_VERTEX_") ||
    name.startsWith("OPENCODE_DEFAULT_") ||
    name === "CODEX_APP_SERVER_URL" ||
    name === "GOOGLE_CLOUD_PROJECT" ||
    name === "GOOGLE_CLOUD_LOCATION"
  );
}

const MODEL_KEY_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "CURSOR_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "OPENCLAW_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
]);

function kindOfSecret(name: string): CredentialKind {
  if (MODEL_KEY_NAMES.has(name) || name.startsWith("CODEX_AUTH_")) return "model-key";
  if (
    name === "GITHUB_TOKEN" ||
    name === "GITLAB_TOKEN" ||
    name.startsWith("GITLAB_TOKEN_") ||
    name.startsWith("GITHUB_USER_") ||
    name.startsWith("GITLAB_USER_")
  )
    return "git-token";
  return "secret";
}

/** The scope a `secrets` row was stored at. */
export function secretScope(row: {
  scope: string;
  workspaceId: string | null;
  userId: string | null;
}): CredentialScope {
  if (row.scope === "user" || row.scope.startsWith("user:") || row.userId) return "personal";
  if (row.scope !== "global") return "repo";
  return row.workspaceId ? "workspace" : "deployment";
}

/** Report a stored secret that was read (secret-service.ts). */
export function noteSecretUse(
  row: {
    id: string;
    name: string;
    scope: string;
    workspaceId: string | null;
    userId: string | null;
  },
  value: string,
  opts?: { agentCredential?: boolean },
): void {
  if (!recordingCredentials() || notACredential(row.name)) return;
  noteCredentialUse({
    kind: opts?.agentCredential ? "model-key" : kindOfSecret(row.name),
    scope: secretScope(row),
    name: row.name,
    credentialId: row.id,
    value,
  });
}

/** Report a credential the API took from its own environment. */
export function noteEnvironmentCredential(name: string, value: string | undefined | null): void {
  if (!value || !recordingCredentials()) return;
  noteCredentialUse({ kind: kindOfSecret(name), scope: "environment", name, value });
}

// ── Search ──────────────────────────────────────────────────────────────────

export interface CredentialUseFilter {
  /** Matched by fingerprint; never stored or logged. */
  value?: string;
  fingerprint?: string;
  name?: string;
  credentialId?: string;
  kind?: CredentialKind;
  scope?: CredentialScope;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface CredentialUseRow {
  id: string;
  runKind: string;
  runId: string;
  workspaceId: string | null;
  workspaceName: string | null;
  userId: string | null;
  userName: string | null;
  userEmail: string | null;
  repoUrl: string | null;
  kind: string;
  scope: string;
  name: string;
  credentialId: string | null;
  host: string | null;
  fingerprint: string | null;
  usedAt: string;
}

export const CREDENTIAL_USE_LIMIT = 1000;

export async function searchCredentialUse(
  filter: CredentialUseFilter,
): Promise<{ rows: CredentialUseRow[]; truncated: boolean }> {
  const conditions: SQL[] = [];
  if (filter.value !== undefined) {
    const fp = credentialFingerprint(filter.value);
    // No key, or nothing pasted: nothing can match.
    if (!fp) return { rows: [], truncated: false };
    conditions.push(eq(runCredentials.fingerprint, fp));
  }
  if (filter.fingerprint)
    conditions.push(eq(runCredentials.fingerprint, filter.fingerprint.toLowerCase()));
  if (filter.name) conditions.push(eq(runCredentials.name, filter.name));
  if (filter.credentialId) conditions.push(eq(runCredentials.credentialId, filter.credentialId));
  if (filter.kind) conditions.push(eq(runCredentials.kind, filter.kind));
  if (filter.scope) conditions.push(eq(runCredentials.scope, filter.scope));
  if (filter.from) conditions.push(gte(runCredentials.usedAt, filter.from));
  if (filter.to) conditions.push(lte(runCredentials.usedAt, filter.to));
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), CREDENTIAL_USE_LIMIT);
  const found = await db
    .select({
      id: runCredentials.id,
      runKind: runCredentials.runKind,
      runId: runCredentials.runId,
      workspaceId: runCredentials.workspaceId,
      workspaceName: workspaces.name,
      userId: runCredentials.userId,
      userName: users.displayName,
      userEmail: users.email,
      repoUrl: runCredentials.repoUrl,
      kind: runCredentials.kind,
      scope: runCredentials.scope,
      name: runCredentials.name,
      credentialId: runCredentials.credentialId,
      host: runCredentials.host,
      fingerprint: runCredentials.fingerprint,
      usedAt: runCredentials.usedAt,
    })
    .from(runCredentials)
    .leftJoin(workspaces, eq(workspaces.id, runCredentials.workspaceId))
    .leftJoin(users, eq(users.id, runCredentials.userId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(runCredentials.usedAt), desc(runCredentials.id))
    .limit(limit + 1);
  return {
    rows: found.slice(0, limit).map((r) => ({ ...r, usedAt: r.usedAt.toISOString() })),
    truncated: found.length > limit,
  };
}

const CSV_COLUMNS: Array<keyof CredentialUseRow> = [
  "usedAt",
  "runKind",
  "runId",
  "workspaceName",
  "workspaceId",
  "userName",
  "userEmail",
  "userId",
  "repoUrl",
  "kind",
  "scope",
  "name",
  "credentialId",
  "host",
  "fingerprint",
];

/** A CSV cell: quoted, and never read as a formula by a spreadsheet. */
function csvCell(value: string | null): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

export function credentialUseCsv(rows: CredentialUseRow[]): string {
  const lines = [CSV_COLUMNS.join(",")];
  for (const row of rows) lines.push(CSV_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}
