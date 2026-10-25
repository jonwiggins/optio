import { randomUUID, X509Certificate } from "node:crypto";
import { eq } from "drizzle-orm";
import { normalizeGitLabBaseUrl } from "@optio/shared";
import { db } from "../db/client.js";
import { gitlabInstances } from "../db/schema.js";
import { decrypt, encrypt, retrieveSecretWithFallback } from "./secret-service.js";
import { configureGitLabInstances } from "./gitlab-instance-runtime.js";
import { rootCertificates } from "node:tls";
import { Agent, fetch as undiciFetch } from "undici";

export interface GitLabInstanceInput {
  baseUrl: string;
  displayName: string;
  caPem?: string | null;
  /** Omitted keeps the saved token; null removes it. */
  token?: string | null;
}
const aad = (id: string) => Buffer.from(`gitlab_instance|${id}`);
type Row = typeof gitlabInstances.$inferSelect;
function tokenOf(row: Row): string | null {
  return row.encryptedToken && row.tokenIv && row.tokenAuthTag
    ? decrypt(
        { alg: 1, ciphertext: row.encryptedToken, iv: row.tokenIv, authTag: row.tokenAuthTag },
        aad(row.id),
      )
    : null;
}
export function validateGitLabInstance(input: GitLabInstanceInput): GitLabInstanceInput {
  const baseUrl = normalizeGitLabBaseUrl(input.baseUrl.trim());
  if (input.caPem) {
    const certs = input.caPem.match(
      /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g,
    );
    if (
      !certs?.length ||
      input.caPem
        .replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, "")
        .trim()
    ) {
      throw new Error("CA certificate must contain PEM certificates only");
    }
    for (const cert of certs) new X509Certificate(cert);
  }
  return { ...input, baseUrl, displayName: input.displayName.trim(), caPem: input.caPem || null };
}
function publicRow(row: Row) {
  return {
    id: row.id,
    baseUrl: row.baseUrl,
    displayName: row.displayName,
    caPem: row.caPem,
    hasToken: !!row.encryptedToken,
    source: "app" as const,
  };
}

let refreshedAt = 0;
let refreshing: Promise<void> | undefined;
export async function refreshGitLabInstances(force = false): Promise<void> {
  if (!force && Date.now() - refreshedAt < 5_000) return;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const rows = await db.select().from(gitlabInstances);
    configureGitLabInstances(
      rows.map((r) => ({ baseUrl: r.baseUrl, caPem: r.caPem, token: tokenOf(r) })),
    );
    refreshedAt = Date.now();
  })();
  try {
    await refreshing;
  } finally {
    refreshing = undefined;
  }
}

/** Environment entries are visible but cannot be edited through the app. */
export async function listGitLabInstances() {
  const rows = await db.select().from(gitlabInstances);
  const savedHost = await retrieveSecretWithFallback("GITLAB_HOST", "global").catch(() => "");
  const env = [
    process.env.GITLAB_HOST,
    savedHost,
    ...(process.env.GITLAB_HOSTS ?? process.env.OPTIO_GITLAB_HOSTS ?? "").split(","),
  ];
  const bases = [
    ...new Set(
      env.filter(Boolean).flatMap((v) => {
        try {
          return [normalizeGitLabBaseUrl(v!)];
        } catch {
          return [];
        }
      }),
    ),
  ];
  return [
    ...rows.map(publicRow),
    ...bases.map((baseUrl) => ({
      id: `environment:${baseUrl}`,
      baseUrl,
      displayName: new URL(baseUrl).host,
      caPem: null,
      hasToken: !!(
        process.env[
          `GITLAB_TOKEN_${new URL(baseUrl).host.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`
        ] || process.env.GITLAB_TOKEN
      ),
      source: "environment" as const,
    })),
  ].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function saveGitLabInstance(input: GitLabInstanceInput, id: string = randomUUID()) {
  const value = validateGitLabInstance(input);
  const all = await db.select().from(gitlabInstances);
  if (all.some((r) => r.id !== id && new URL(r.baseUrl).host === new URL(value.baseUrl).host))
    throw new Error("An instance already uses this host and port");
  const old = all.find((r) => r.id === id);
  const blob = value.token ? encrypt(value.token, aad(id)) : null;
  const tokenFields =
    value.token === undefined
      ? {}
      : {
          encryptedToken: blob?.ciphertext ?? null,
          tokenIv: blob?.iv ?? null,
          tokenAuthTag: blob?.authTag ?? null,
        };
  // A URL change never silently sends the previous endpoint's token to a new server.
  if (old && old.baseUrl !== value.baseUrl && value.token === undefined && old.encryptedToken) {
    throw new Error("Enter the token again or remove it when changing the base URL");
  }
  const values = {
    baseUrl: value.baseUrl,
    displayName: value.displayName,
    caPem: value.caPem,
    ...tokenFields,
    updatedAt: new Date(),
  };
  const [row] = old
    ? await db.update(gitlabInstances).set(values).where(eq(gitlabInstances.id, id)).returning()
    : await db
        .insert(gitlabInstances)
        .values({ id, ...values })
        .returning();
  await refreshGitLabInstances(true);
  return publicRow(row);
}
export async function deleteGitLabInstance(id: string): Promise<boolean> {
  const deleted = await db
    .delete(gitlabInstances)
    .where(eq(gitlabInstances.id, id))
    .returning({ id: gitlabInstances.id });
  await refreshGitLabInstances(true);
  return deleted.length > 0;
}

/** Tests unsaved settings, or reuses the saved token for the same endpoint only. */
export async function testGitLabInstance(input: GitLabInstanceInput, id?: string) {
  const value = validateGitLabInstance(input);
  let token = value.token;
  if (token === undefined && id) {
    const [row] = await db.select().from(gitlabInstances).where(eq(gitlabInstances.id, id));
    if (row?.baseUrl === value.baseUrl) token = tokenOf(row);
  }
  if (!token) throw new Error("Enter a token to test the connection");
  const agent = value.caPem
    ? new Agent({ connect: { ca: [...rootCertificates, value.caPem] } })
    : null;
  try {
    const get = async (path: string) => {
      const options = {
        headers: { Authorization: `Bearer ${token}`, "User-Agent": "Optio" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        ...(agent ? { dispatcher: agent } : {}),
      };
      const url = `${value.baseUrl}/api/v4/${path}`;
      const res = agent
        ? await undiciFetch(url, options as Parameters<typeof undiciFetch>[1])
        : await fetch(url, options as RequestInit);
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`GitLab ${path} returned HTTP ${res.status}`);
      }
      return (await res.json()) as Record<string, unknown>;
    };
    const version = await get("version");
    const user = await get("user");
    return {
      ok: true,
      version: String(version.version ?? ""),
      username: String(user.username ?? ""),
    };
  } finally {
    await agent?.close();
  }
}
