/**
 * Agent policy (docs/agent-policy.md): the shapes of
 * apps/api/src/routes/agent-policy.ts. The calls are on `api` (api-client.ts).
 */

export type RuleSource = "built-in" | "workspace" | "repo";

export interface PolicyRule {
  rule: string;
  from: RuleSource;
  /** OpenCode gets an equivalent (Read, Edit, Write and Bash rules). */
  opencode: boolean;
}

export interface StoredPolicy {
  builtInRules?: boolean;
  denyRules?: string[];
}

export interface EgressView {
  mode: "allowlist" | "default" | "not-set" | "invalid";
  entries: Array<{ name: string; to: string[]; ports: number[] }>;
  error?: string;
}

export interface WorkspacePolicyView {
  policy: StoredPolicy | null;
  effective: {
    builtInRules: boolean;
    builtInFrom: "deployment" | "workspace" | null;
    rules: PolicyRule[];
  };
  builtIn: string[];
  deployment: {
    builtInRules: boolean;
    runtimeClassName: string | null;
    runtimeClassError?: string;
    egress: EgressView;
  };
  canEdit: boolean;
}

export interface RepoPolicyView {
  policy: StoredPolicy | null;
  canEdit: boolean;
}

/** One rule per line, blank lines dropped. */
export function parseRules(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

export const SOURCE_LABEL: Record<RuleSource, string> = {
  "built-in": "Built-in",
  workspace: "Workspace",
  repo: "Repo",
};
