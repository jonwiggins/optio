import { eq, and, isNull } from "drizzle-orm";
import { db } from "../db/client.js";
import { repos, workspaces } from "../db/schema.js";
import { encrypt, decrypt, ALG_AES_256_GCM_V1 } from "./secret-service.js";
import { normalizeRepoUrl, parseRepoUrl } from "@optio/shared";

export interface RepoRecord {
  id: string;
  repoUrl: string;
  gitPlatform: string;
  workspaceId: string | null;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  imagePreset: string | null;
  extraPackages: string | null;
  setupCommands: string | null;
  customDockerfile: string | null;
  autoMerge: boolean;
  cautiousMode: boolean;
  defaultAgentType: string;
  promptTemplateOverride: string | null;
  claudeModel: string | null;
  claudeContextWindow: string | null;
  claudeThinking: boolean;
  claudeEffort: string | null;
  copilotModel: string | null;
  copilotEffort: string | null;
  opencodeModel: string | null;
  opencodeAgent: string | null;
  opencodeProvider: string | null;
  opencodeBaseUrl: string | null;
  geminiModel: string | null;
  geminiApprovalMode: string | null;
  maxTurnsCoding: number | null;
  maxTurnsReview: number | null;
  autoResume: boolean;
  planningModeEnabled: boolean;
  maxConcurrentTasks: number;
  maxPodInstances: number;
  maxAgentsPerPod: number;
  reviewEnabled: boolean;
  reviewTrigger: string | null;
  reviewPromptTemplate: string | null;
  testCommand: string | null;
  reviewAgentType: string | null;
  reviewModel: string | null;
  maxAutoResumes: number | null;
  externalReviewMode: string;
  externalReviewFilters: {
    skipDrafts?: boolean;
    skipOptioAuthored?: boolean;
    includeAuthors?: string[];
    excludeAuthors?: string[];
    includeLabels?: string[];
    excludeLabels?: string[];
  } | null;
  externalReviewWaitForCi: boolean;
  slackWebhookUrl: string | null;
  slackChannel: string | null;
  slackNotifyOn: string[] | null;
  slackEnabled: boolean;
  networkPolicy: string;
  secretProxy: boolean;
  offPeakOnly: boolean;
  cpuRequest: string | null;
  cpuLimit: string | null;
  memoryRequest: string | null;
  memoryLimit: string | null;
  dockerInDocker: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Decrypt the encrypted Slack webhook URL from a raw DB row and map to RepoRecord shape.
 */
function decryptRepoRow(row: typeof repos.$inferSelect): RepoRecord {
  let slackWebhookUrl: string | null = null;
  if (row.encryptedSlackWebhookUrl && row.slackWebhookUrlIv && row.slackWebhookUrlAuthTag) {
    const aad = Buffer.from(`repo:${row.id}:slackWebhookUrl`);
    slackWebhookUrl = decrypt(
      {
        alg: row.slackWebhookUrlAlg ?? ALG_AES_256_GCM_V1,
        iv: row.slackWebhookUrlIv,
        ciphertext: row.encryptedSlackWebhookUrl,
        authTag: row.slackWebhookUrlAuthTag,
      },
      aad,
    );
  }
  const {
    encryptedSlackWebhookUrl: _e,
    slackWebhookUrlIv: _iv,
    slackWebhookUrlAuthTag: _tag,
    slackWebhookUrlAlg: _alg,
    ...rest
  } = row;
  return { ...rest, slackWebhookUrl } as RepoRecord;
}

export async function listRepos(workspaceId?: string | null): Promise<RepoRecord[]> {
  const rows = workspaceId
    ? await db.select().from(repos).where(eq(repos.workspaceId, workspaceId))
    : await db.select().from(repos);
  return rows.map(decryptRepoRow);
}

export async function getRepo(id: string): Promise<RepoRecord | null> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, id));
  if (!repo) return null;
  return decryptRepoRow(repo);
}

async function getDefaultWorkspaceId(): Promise<string | null> {
  const [ws] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.slug, "default"));
  return ws?.id ?? null;
}

export async function getRepoByUrl(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<RepoRecord | null> {
  const normalized = normalizeRepoUrl(repoUrl);
  const conditions = [eq(repos.repoUrl, normalized)];
  if (workspaceId) {
    conditions.push(eq(repos.workspaceId, workspaceId));
  } else {
    // When no workspace is specified, try the default workspace first,
    // then fall back to any repo with a NULL workspace_id
    const defaultWsId = await getDefaultWorkspaceId();
    if (defaultWsId) {
      const [repo] = await db
        .select()
        .from(repos)
        .where(and(eq(repos.repoUrl, normalized), eq(repos.workspaceId, defaultWsId)));
      if (repo) return decryptRepoRow(repo);
    }
    conditions.push(isNull(repos.workspaceId));
  }
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(...conditions));
  if (!repo) return null;
  return decryptRepoRow(repo);
}

export async function createRepo(data: {
  repoUrl: string;
  fullName: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  workspaceId?: string | null;
}): Promise<RepoRecord> {
  // Ensure repos always have a workspace assigned — prevents NULL workspace_id
  // rows which bypass the (repo_url, workspace_id) unique constraint
  const workspaceId = data.workspaceId || (await getDefaultWorkspaceId()) || undefined;

  const parsedUrl = parseRepoUrl(data.repoUrl);
  const gitPlatform = parsedUrl?.platform ?? "github";

  const [repo] = await db
    .insert(repos)
    .values({
      repoUrl: normalizeRepoUrl(data.repoUrl),
      gitPlatform,
      fullName: data.fullName,
      defaultBranch: data.defaultBranch ?? "main",
      isPrivate: data.isPrivate ?? false,
      workspaceId,
    })
    .onConflictDoUpdate({
      target: [repos.repoUrl, repos.workspaceId],
      set: {
        fullName: data.fullName,
        defaultBranch: data.defaultBranch ?? "main",
        isPrivate: data.isPrivate ?? false,
        updatedAt: new Date(),
      },
    })
    .returning();
  return decryptRepoRow(repo);
}

export async function updateRepo(
  id: string,
  data: {
    imagePreset?: string;
    extraPackages?: string;
    setupCommands?: string;
    customDockerfile?: string | null;
    autoMerge?: boolean;
    defaultAgentType?: string;
    promptTemplateOverride?: string | null;
    defaultBranch?: string;
    claudeModel?: string;
    claudeContextWindow?: string;
    claudeThinking?: boolean;
    claudeEffort?: string;
    maxTurnsCoding?: number;
    maxTurnsReview?: number;
    autoResume?: boolean;
    maxConcurrentTasks?: number;
    maxPodInstances?: number;
    maxAgentsPerPod?: number;
    reviewEnabled?: boolean;
    reviewTrigger?: string;
    reviewPromptTemplate?: string | null;
    testCommand?: string;
    reviewAgentType?: string | null;
    reviewModel?: string;
    externalReviewMode?: string;
    externalReviewFilters?: {
      skipDrafts?: boolean;
      skipOptioAuthored?: boolean;
      includeAuthors?: string[];
      excludeAuthors?: string[];
      includeLabels?: string[];
      excludeLabels?: string[];
    } | null;
    externalReviewWaitForCi?: boolean;
    slackWebhookUrl?: string | null;
    slackChannel?: string | null;
    slackNotifyOn?: string[];
    slackEnabled?: boolean;
    networkPolicy?: string;
    secretProxy?: boolean;
    offPeakOnly?: boolean;
    cpuRequest?: string | null;
    cpuLimit?: string | null;
    memoryRequest?: string | null;
    memoryLimit?: string | null;
    dockerInDocker?: boolean;
  },
): Promise<RepoRecord | null> {
  // Extract slackWebhookUrl for encryption; pass everything else through
  const { slackWebhookUrl, ...restData } = data;
  const setData: Record<string, unknown> = { ...restData, updatedAt: new Date() };

  if (slackWebhookUrl !== undefined) {
    if (slackWebhookUrl === null) {
      setData.encryptedSlackWebhookUrl = null;
      setData.slackWebhookUrlIv = null;
      setData.slackWebhookUrlAuthTag = null;
    } else {
      const aad = Buffer.from(`repo:${id}:slackWebhookUrl`);
      const blob = encrypt(slackWebhookUrl, aad);
      setData.encryptedSlackWebhookUrl = blob.ciphertext;
      setData.slackWebhookUrlIv = blob.iv;
      setData.slackWebhookUrlAuthTag = blob.authTag;
      setData.slackWebhookUrlAlg = blob.alg;
    }
  }

  const [repo] = await db.update(repos).set(setData).where(eq(repos.id, id)).returning();
  if (!repo) return null;
  return decryptRepoRow(repo);
}

export async function deleteRepo(id: string): Promise<void> {
  // Look up the repo URL before deletion for PVC cleanup
  const repo = await getRepo(id);
  if (repo) {
    try {
      const { cleanupCachePvcsForRepo, cleanupHomePvcsForRepo } =
        await import("./shared-directory-service.js");
      await cleanupCachePvcsForRepo(repo.repoUrl);
      await cleanupHomePvcsForRepo(repo.repoUrl);
    } catch {
      // PVC cleanup is best-effort — don't block repo deletion
    }
  }
  await db.delete(repos).where(eq(repos.id, id));
}
