export interface TaskSummary {
  id: string;
  title: string;
  state: string;
  repoUrl: string;
  repoBranch?: string;
  agentType?: string;
  prUrl?: string;
  prNumber?: number;
  costUsd?: string;
  createdAt: string;
  updatedAt: string;
}

export interface RepoSummary {
  id: string;
  repoUrl: string;
  fullName?: string;
  defaultBranch?: string;
  imagePreset?: string;
  maxConcurrentTasks?: number;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  repoUrl: string;
  branch: string;
  state: string;
  createdAt: string;
}

export interface SecretSummary {
  id: string;
  name: string;
  scope: string;
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  description?: string;
}

export interface UserInfo {
  id: string;
  email: string;
  displayName: string;
  provider?: string;
  avatarUrl?: string | null;
}
