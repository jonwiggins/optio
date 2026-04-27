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

/**
 * Layout discriminator for a custom skill:
 *  - "commands"  → written to `.claude/commands/<name>.md` (legacy single-file).
 *  - "skill-dir" → written to `.claude/skills/<name>/SKILL.md`, plus any
 *                  `files` entries resolved under `.claude/skills/<name>/`.
 */
export type CustomSkillLayout = "commands" | "skill-dir";

export interface CustomSkillFile {
  /** Relative path under `.claude/skills/<name>/`. Forward slashes only. */
  relativePath: string;
  content: string;
}

export interface CustomSkillConfig {
  id: string;
  name: string;
  description?: string | null;
  prompt: string;
  scope: string; // "global" or repo URL
  repoUrl?: string | null;
  workspaceId?: string | null;
  layout: CustomSkillLayout;
  /** Extra files for skill-dir layout. Null/empty = none. */
  files?: CustomSkillFile[] | null;
  /** Agent types this skill applies to. null/empty = all agent types. */
  agentTypes?: string[] | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomSkillInput {
  name: string;
  description?: string;
  prompt: string;
  repoUrl?: string;
  layout?: CustomSkillLayout;
  files?: CustomSkillFile[];
  agentTypes?: string[];
  enabled?: boolean;
}

export interface UpdateCustomSkillInput {
  name?: string;
  description?: string | null;
  prompt?: string;
  layout?: CustomSkillLayout;
  files?: CustomSkillFile[] | null;
  agentTypes?: string[] | null;
  enabled?: boolean;
}

/**
 * A skill installed from a remote source (e.g. an Anthropic marketplace
 * "skill" repo). The body of the skill lives in a content-addressable cache
 * PVC keyed by `resolvedSha`; the row records what to fetch and how to scope
 * it. Today only `sourceType = "git"` is supported.
 */
export type InstalledSkillSourceType = "git";

export interface InstalledSkillManifest {
  /** SKILL.md frontmatter (best-effort YAML parse). */
  frontmatter?: Record<string, unknown>;
  /** Files discovered under the resolved subpath. */
  files?: Array<{ relativePath: string; sizeBytes: number; executable: boolean }>;
}

export interface InstalledSkillConfig {
  id: string;
  name: string;
  description?: string | null;
  sourceType: InstalledSkillSourceType;
  sourceUrl: string;
  ref: string;
  resolvedSha?: string | null;
  subpath: string;
  scope: string;
  repoUrl?: string | null;
  workspaceId?: string | null;
  agentTypes?: string[] | null;
  enabled: boolean;
  lastSyncedAt?: Date | null;
  lastSyncError?: string | null;
  cachedManifest?: InstalledSkillManifest | null;
  hasExecutableFiles: boolean;
  totalSizeBytes?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateInstalledSkillInput {
  name: string;
  description?: string;
  sourceUrl: string;
  ref?: string;
  subpath?: string;
  repoUrl?: string;
  agentTypes?: string[];
  enabled?: boolean;
}

export interface UpdateInstalledSkillInput {
  name?: string;
  description?: string | null;
  ref?: string;
  subpath?: string;
  agentTypes?: string[] | null;
  enabled?: boolean;
}
