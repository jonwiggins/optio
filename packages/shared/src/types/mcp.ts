export interface McpServerConfig {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string> | null;
  installCommand?: string | null;
  scope: string; // "global" or repo URL
  repoUrl?: string | null;
  workspaceId?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMcpServerInput {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  installCommand?: string;
  repoUrl?: string;
  enabled?: boolean;
}

export interface UpdateMcpServerInput {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string> | null;
  installCommand?: string | null;
  enabled?: boolean;
}

export interface CustomSkillConfig {
  id: string;
  name: string;
  description?: string | null;
  prompt: string;
  scope: string; // "global" or repo URL
  repoUrl?: string | null;
  workspaceId?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomSkillInput {
  name: string;
  description?: string;
  prompt: string;
  repoUrl?: string;
  enabled?: boolean;
}

export interface UpdateCustomSkillInput {
  name?: string;
  description?: string | null;
  prompt?: string;
  enabled?: boolean;
}
