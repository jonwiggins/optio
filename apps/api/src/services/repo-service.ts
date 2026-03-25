import { eq, and } from "drizzle-orm";
import { db } from "../db/client.js";
import { repos } from "../db/schema.js";
import { normalizeRepoUrl } from "@optio/shared";

export interface RepoRecord {
  id: string;
  repoUrl: string;
  workspaceId: string | null;
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
  imagePreset: string | null;
  extraPackages: string | null;
  setupCommands: string | null;
  customDockerfile: string | null;
  autoMerge: boolean;
  promptTemplateOverride: string | null;
  claudeModel: string | null;
  claudeContextWindow: string | null;
  claudeThinking: boolean;
  claudeEffort: string | null;
  maxTurnsCoding: number | null;
  maxTurnsReview: number | null;
  autoResume: boolean;
  maxConcurrentTasks: number;
  maxPodInstances: number;
  maxAgentsPerPod: number;
  reviewEnabled: boolean;
  reviewTrigger: string | null;
  reviewPromptTemplate: string | null;
  testCommand: string | null;
  reviewModel: string | null;
  maxAutoResumes: number | null;
  slackWebhookUrl: string | null;
  slackChannel: string | null;
  slackNotifyOn: string[] | null;
  slackEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export async function listRepos(workspaceId?: string | null): Promise<RepoRecord[]> {
  if (workspaceId) {
    return db.select().from(repos).where(eq(repos.workspaceId, workspaceId)) as Promise<
      RepoRecord[]
    >;
  }
  return db.select().from(repos) as Promise<RepoRecord[]>;
}

export async function getRepo(id: string): Promise<RepoRecord | null> {
  const [repo] = await db.select().from(repos).where(eq(repos.id, id));
  return (repo as RepoRecord) ?? null;
}

export async function getRepoByUrl(
  repoUrl: string,
  workspaceId?: string | null,
): Promise<RepoRecord | null> {
  const normalized = normalizeRepoUrl(repoUrl);
  const conditions = [eq(repos.repoUrl, normalized)];
  if (workspaceId) conditions.push(eq(repos.workspaceId, workspaceId));
  const [repo] = await db
    .select()
    .from(repos)
    .where(and(...conditions));
  return (repo as RepoRecord) ?? null;
}

export async function createRepo(data: {
  repoUrl: string;
  fullName: string;
  defaultBranch?: string;
  isPrivate?: boolean;
  workspaceId?: string | null;
}): Promise<RepoRecord> {
  const [repo] = await db
    .insert(repos)
    .values({
      repoUrl: normalizeRepoUrl(data.repoUrl),
      fullName: data.fullName,
      defaultBranch: data.defaultBranch ?? "main",
      isPrivate: data.isPrivate ?? false,
      workspaceId: data.workspaceId ?? undefined,
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
  return repo as RepoRecord;
}

export async function updateRepo(
  id: string,
  data: {
    imagePreset?: string;
    extraPackages?: string;
    setupCommands?: string;
    customDockerfile?: string | null;
    autoMerge?: boolean;
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
    reviewModel?: string;
    slackWebhookUrl?: string | null;
    slackChannel?: string | null;
    slackNotifyOn?: string[];
    slackEnabled?: boolean;
  },
): Promise<RepoRecord | null> {
  const [repo] = await db
    .update(repos)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(repos.id, id))
    .returning();
  return (repo as RepoRecord) ?? null;
}

export async function deleteRepo(id: string): Promise<void> {
  await db.delete(repos).where(eq(repos.id, id));
}
