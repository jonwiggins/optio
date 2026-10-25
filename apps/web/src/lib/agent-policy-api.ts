/**
 * Agent policy (docs/agent-policy.md): the deny rules every agent pod gets,
 * per workspace with rules added per team and per repo, the egress
 * allowlist and the RuntimeClasses. The API is
 * apps/api/src/routes/agent-policy.ts.
 */
import { request } from "@/lib/api-client";

export type RuleSource = "default" | "workspace" | "team" | "repo";

export interface PolicyRule {
  rule: string;
  from: RuleSource;
  /** OpenCode gets an equivalent (Read, Edit, Write and Bash rules). */
  opencode: boolean;
}

export interface StoredPolicy {
  defaults?: boolean | null;
  denyRules?: string[];
  runtimeClassName?: string | null;
}

export interface RuntimeClasses {
  /** The chart's agent.runtimeClassName; null = the cluster's default runtime. */
  deployment: string | null;
  /** The classes a repo may pick. */
  available: string[];
}

export interface EgressView {
  mode: "allowlist" | "any-https" | "unenforced";
  always: string[];
  entries: Array<{ name: string; to: string[]; ports: number[] }>;
}

export interface WorkspacePolicyView {
  policy: StoredPolicy | null;
  effective: {
    defaults: boolean;
    defaultsFrom: "profile" | "workspace";
    rules: PolicyRule[];
    runtimeClassName: string | null;
    runtimeClassFrom: "deployment" | "repo" | null;
  };
  builtIn: string[];
  profileDefaults: boolean;
  egress: EgressView;
  runtime: RuntimeClasses;
  canEdit: boolean;
}

export interface LevelPolicyView {
  policy: StoredPolicy | null;
  canEdit: boolean;
  runtime?: RuntimeClasses;
}

export interface RunPolicy {
  defaults: boolean;
  defaultsFrom: "profile" | "workspace";
  rules: PolicyRule[];
  runtimeClassName: string | null;
  runtimeClassFrom: "deployment" | "repo" | null;
  agentType: string | null;
  enforcedBy: "claude-managed-settings" | "opencode-config" | null;
  notEnforced: string[];
  appliedAt: string;
}

const put = (body: unknown): RequestInit => ({ method: "PUT", body: JSON.stringify(body) });
const id = (v: string) => encodeURIComponent(v);

export const agentPolicyApi = {
  workspace: () => request<WorkspacePolicyView>("/api/agent-policy"),
  /** `defaults: null` follows the deployment's default again. */
  setWorkspace: (body: { defaults?: boolean | null; denyRules?: string[] }) =>
    request<LevelPolicyView>("/api/agent-policy", put(body)),
  team: (teamId: string) => request<LevelPolicyView>(`/api/teams/${id(teamId)}/agent-policy`),
  setTeam: (teamId: string, body: { denyRules: string[] }) =>
    request<LevelPolicyView>(`/api/teams/${id(teamId)}/agent-policy`, put(body)),
  repo: (repoId: string) => request<LevelPolicyView>(`/api/repos/${id(repoId)}/agent-policy`),
  setRepo: (repoId: string, body: { denyRules?: string[]; runtimeClassName?: string | null }) =>
    request<LevelPolicyView>(`/api/repos/${id(repoId)}/agent-policy`, put(body)),
  run: (runId: string) =>
    request<{ policy: RunPolicy | null }>(`/api/runs/${id(runId)}/agent-policy`),
};

/** One rule per line, blank lines dropped. */
export function parseRules(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export const SOURCE_LABEL: Record<RuleSource, string> = {
  default: "Built-in",
  workspace: "Workspace",
  team: "Team",
  repo: "Repo",
};
