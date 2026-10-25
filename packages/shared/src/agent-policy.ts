/**
 * Agent policy (docs/agent-policy.md): what agents may not do, whatever the
 * repo or the prompt asks.
 *
 * Optio starts agents with their permission checks skipped
 * (`--dangerously-skip-permissions`), and they read prompts from merge
 * request descriptions and tickets anyone may write. A policy is a list of
 * Claude Code permission rules (`Read(**\/.env*)`, `Bash(git push --force *)`)
 * that Optio writes into the **managed** settings tier,
 * `/etc/claude-code/managed-settings.json`, which a repo's own
 * `.claude/settings.json` cannot override and which Claude Code enforces even
 * in bypass-permissions mode. OpenCode gets the same rules in its own
 * permission syntax.
 *
 * Levels, each a jsonb column (additive, null = nothing set):
 *
 * - the workspace (`workspaces.agent_policy`): whether the built-in rules are
 *   on (`defaults`; unset = the deployment's, `OPTIO_AGENT_POLICY_DEFAULTS`,
 *   off by default as upstream) and rules of its own;
 * - a team (`teams.agent_policy`): rules added for the team's work;
 * - a repo (`repos.agent_policy`): rules added for work in it, and the
 *   Kubernetes RuntimeClass its pods run under (gVisor, Kata), over the
 *   deployment's (`agent.runtimeClassName`).
 *
 * Team and repo rules only add: a lower level can't take a rule away.
 */
import { currentFeatures, type DeploymentFeatures } from "./config/features.js";

/** Where Claude Code reads its managed settings on Linux. */
export const CLAUDE_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/** The most rules one level may hold, and the longest rule. */
export const AGENT_POLICY_MAX_RULES = 100;
export const AGENT_POLICY_RULE_MAX_LENGTH = 300;

/**
 * The built-in deny rules: secrets in the checkout and the agent's home,
 * rewriting published history, piping a download into a shell, and editing
 * the managed settings file itself. Off by default; on where the deployment
 * sets `OPTIO_AGENT_POLICY_DEFAULTS=true` or a workspace admin turns them on.
 */
export const STANDARD_DENY_RULES: readonly string[] = [
  "Read(**/.env*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(~/.git-credentials)",
  "Read(~/.ssh/**)",
  "Edit(//etc/claude-code/**)",
  // A plain --force only, as a whole flag: --force-with-lease (what Optio's own
  // conflict prompts use on the run's branch) is allowed.
  "Bash(git push --force)",
  "Bash(git push --force *)",
  "Bash(git push -f*)",
  "Bash(git push * --force)",
  "Bash(git push * --force *)",
  "Bash(git push * -f*)",
  "Bash(curl * | sh*)",
  "Bash(curl * | bash*)",
  "Bash(wget * | sh*)",
  "Bash(wget * | bash*)",
  "Bash(rm -rf /)",
  "Bash(rm -rf ~)",
];

/** What one level stores. Every field is optional; null/absent = not set here. */
export interface AgentPolicy {
  /** Workspace only: the built-in rules on or off; null = the deployment's default. */
  defaults?: boolean | null;
  /** Claude Code permission rules added to the deny list. */
  denyRules?: string[];
  /** Repo only: the RuntimeClass the repo's pods run under; null = the deployment's. */
  runtimeClassName?: string | null;
}

export type AgentPolicyLevel = "workspace" | "team" | "repo";
export type AgentPolicyRuleSource = "default" | AgentPolicyLevel;

export interface AgentPolicyRule {
  rule: string;
  /** Where the rule comes from: the built-in list, or the level that added it. */
  from: AgentPolicyRuleSource;
}

/** The policy a run gets: its workspace's, its team's and its repo's together. */
export interface EffectiveAgentPolicy {
  /** Whether the built-in rules apply. */
  defaults: boolean;
  /**
   * Who decided that: the deployment's default (`OPTIO_AGENT_POLICY_DEFAULTS`;
   * stored as "profile" in runs' records), or the workspace's admin.
   */
  defaultsFrom: "profile" | "workspace";
  /** Every deny rule, each once, the built-in ones first. */
  rules: AgentPolicyRule[];
  /** The pods' RuntimeClass; null = the cluster's default runtime. */
  runtimeClassName: string | null;
  runtimeClassFrom: "deployment" | "repo" | null;
}

/** What a run started with (`run_agent_policies.policy`), shown on its page. */
export interface RunAgentPolicy extends EffectiveAgentPolicy {
  /** The agent runtime the rules were written for. */
  agentType: string | null;
  /**
   * How the rules reached the agent: Claude Code's managed settings file,
   * OpenCode's inline config, or not at all (a runtime with no equivalent,
   * or no rules).
   */
  enforcedBy: "claude-managed-settings" | "opencode-config" | null;
  /** Rules the runtime has no equivalent for (OpenCode: all but Read, Edit, Write, Bash). */
  notEnforced: string[];
  /** When the run's pod got them (ISO 8601). */
  appliedAt: string;
}

/**
 * Whether the deployment turns the built-in rules on when a workspace hasn't
 * said (`OPTIO_AGENT_POLICY_DEFAULTS`; off by default).
 */
export function agentPolicyDefaultsOn(features: DeploymentFeatures = currentFeatures()): boolean {
  return features.agentPolicyDefaults;
}

const RULE = /^([A-Za-z][A-Za-z0-9_-]*)(\((.*)\))?$/;
const RUNTIME_CLASS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** Why `rule` isn't a Claude Code permission rule, or null when it is one. */
export function denyRuleError(rule: string): string | null {
  if (!rule) return "A rule can't be empty";
  if (rule.length > AGENT_POLICY_RULE_MAX_LENGTH) {
    return `"${rule.slice(0, 40)}…" is longer than ${AGENT_POLICY_RULE_MAX_LENGTH} characters`;
  }
  if (/[\r\n\t]/.test(rule)) return `"${rule}" has a line break or a tab`;
  const m = RULE.exec(rule);
  if (!m) {
    return `"${rule}" isn't a permission rule: write a tool, or a tool and what it applies to, such as Read(**/.env*) or Bash(git push --force *)`;
  }
  if (m[2] !== undefined && !m[3].trim()) return `"${rule}" has nothing between the brackets`;
  return null;
}

/** Why `name` isn't a RuntimeClass name (a DNS subdomain), or null when it is one. */
export function runtimeClassNameError(name: string): string | null {
  if (name.length > 253 || !RUNTIME_CLASS.test(name)) {
    return `"${name}" isn't a RuntimeClass name (lowercase letters, digits, "-" and ".")`;
  }
  return null;
}

/**
 * A level's policy as stored: rules trimmed, blank ones dropped, each once,
 * the fields its level may hold only; null when nothing is left. Throws an
 * `AgentPolicyError` naming every bad rule.
 */
export function cleanAgentPolicy(input: AgentPolicy, level: AgentPolicyLevel): AgentPolicy | null {
  const errors: string[] = [];
  const rules = [...new Set((input.denyRules ?? []).map((r) => r.trim()).filter(Boolean))];
  for (const r of rules) {
    const err = denyRuleError(r);
    if (err) errors.push(err);
  }
  if (rules.length > AGENT_POLICY_MAX_RULES) {
    errors.push(`At most ${AGENT_POLICY_MAX_RULES} rules`);
  }
  const out: AgentPolicy = {};
  if (rules.length > 0) out.denyRules = rules;
  if (level === "workspace" && typeof input.defaults === "boolean") out.defaults = input.defaults;
  if (level === "repo" && input.runtimeClassName) {
    const name = input.runtimeClassName.trim();
    const err = name ? runtimeClassNameError(name) : null;
    if (err) errors.push(err);
    else if (name) out.runtimeClassName = name;
  }
  if (errors.length > 0) throw new AgentPolicyError(errors.join("; "));
  return Object.keys(out).length > 0 ? out : null;
}

export class AgentPolicyError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "AgentPolicyError";
  }
}

/** Reads a stored level leniently: what isn't a list of strings is ignored. */
function storedRules(p: AgentPolicy | null | undefined): string[] {
  return Array.isArray(p?.denyRules)
    ? p!.denyRules.filter((r): r is string => typeof r === "string" && !!r.trim())
    : [];
}

/** The policy for work in `repo`, owned by `team`, in `workspace`. */
export function resolveAgentPolicy(input: {
  workspace?: AgentPolicy | null;
  team?: AgentPolicy | null;
  repo?: AgentPolicy | null;
  /** The deployment's RuntimeClass (`agent.runtimeClassName`); null = none. */
  deploymentRuntimeClass?: string | null;
  /** The deployment's default for the built-in rules; `agentPolicyDefaultsOn()` when absent. */
  builtInDefaults?: boolean;
}): EffectiveAgentPolicy {
  const chosen = input.workspace?.defaults;
  const defaults =
    typeof chosen === "boolean" ? chosen : (input.builtInDefaults ?? agentPolicyDefaultsOn());
  const rules: AgentPolicyRule[] = [];
  const seen = new Set<string>();
  const add = (rule: string, from: AgentPolicyRuleSource) => {
    const r = rule.trim();
    if (!r || seen.has(r)) return;
    seen.add(r);
    rules.push({ rule: r, from });
  };
  if (defaults) for (const r of STANDARD_DENY_RULES) add(r, "default");
  for (const r of storedRules(input.workspace)) add(r, "workspace");
  for (const r of storedRules(input.team)) add(r, "team");
  for (const r of storedRules(input.repo)) add(r, "repo");
  const repoClass =
    typeof input.repo?.runtimeClassName === "string" && input.repo.runtimeClassName.trim()
      ? input.repo.runtimeClassName.trim()
      : null;
  const deploymentClass = input.deploymentRuntimeClass?.trim() || null;
  return {
    defaults,
    defaultsFrom: typeof chosen === "boolean" ? "workspace" : "profile",
    rules,
    runtimeClassName: repoClass ?? deploymentClass,
    runtimeClassFrom: repoClass ? "repo" : deploymentClass ? "deployment" : null,
  };
}

/**
 * Claude Code's managed settings for a policy: `permissions.deny`, nothing
 * else (an unknown key could make Claude Code reject the file). Null when the
 * policy has no rules, so nothing is written and upstream's behaviour stays.
 */
export function claudeManagedSettings(
  policy: Pick<EffectiveAgentPolicy, "rules">,
): { permissions: { deny: string[] } } | null {
  if (policy.rules.length === 0) return null;
  return { permissions: { deny: policy.rules.map((r) => r.rule) } };
}

/** OpenCode's permission keys for Claude Code's tools; a tool not here is Claude Code only. */
const OPENCODE_TOOL: Readonly<Record<string, string>> = {
  Read: "read",
  Edit: "edit",
  Write: "edit",
  MultiEdit: "edit",
  Bash: "bash",
};

/**
 * One Claude Code path pattern (gitignore-style: `**\/x` at any depth, `//x`
 * absolute, `~/x` in the home, else relative to the working directory) as
 * OpenCode's simple wildcards, where `*` matches any characters, `/`
 * included. A pattern may stand for several (a relative path, and the same
 * path under any directory, as OpenCode may see either). Never narrower
 * than Claude Code's.
 */
export function opencodePathPatterns(spec: string): string[] {
  let p = spec.trim();
  if (p.startsWith("//")) return [p.slice(1).replace(/\*\*/g, "*")];
  if (p.startsWith("~/")) p = `**/${p.slice(2)}`;
  else if (p.startsWith("./")) p = p.slice(2);
  else if (p.startsWith("/")) p = p.slice(1);
  if (p.startsWith("**/")) p = p.slice(3);
  p = p.replace(/\*\*/g, "*");
  return p.startsWith("*") ? [p] : [p, `*/${p}`];
}

/** One Claude Code Bash pattern as OpenCode's (`cmd:*`, the old prefix form, is `cmd*`). */
function opencodeBashPattern(spec: string): string {
  const p = spec.trim();
  return p.endsWith(":*") ? `${p.slice(0, -2)}*` : p;
}

/** Whether OpenCode gets an equivalent of `rule` (else it's Claude Code's only). */
export function opencodeSupportsRule(rule: string): boolean {
  const m = RULE.exec(rule.trim());
  return !!m && m[1] in OPENCODE_TOOL;
}

/**
 * The deny rules as OpenCode `permission` entries: `{ read: { "*.pem": "deny" } }`.
 * No `"*"` entry per tool, so what isn't denied falls to the base block's
 * rules (OpenCode: the last matching rule wins). A bare tool (`Bash`) denies
 * the whole tool.
 */
export function opencodeDenyPermission(
  rules: readonly string[],
): Record<string, Record<string, "deny">> {
  const out: Record<string, Record<string, "deny">> = {};
  for (const rule of rules) {
    const m = RULE.exec(rule.trim());
    if (!m) continue;
    const tool = OPENCODE_TOOL[m[1]];
    if (!tool) continue;
    const spec = m[3];
    const patterns =
      spec === undefined
        ? ["*"]
        : tool === "bash"
          ? [opencodeBashPattern(spec)]
          : opencodePathPatterns(spec);
    out[tool] ??= {};
    for (const p of patterns) out[tool][p] = "deny";
  }
  return out;
}

type OpencodePermission = Record<string, string | Record<string, string>>;

/**
 * `extra`'s deny entries added to `base` (the headless block every OpenCode
 * run gets): a tool `base` sets to one action becomes `{ "*": action }` and
 * then the denials, so they come last and win.
 */
export function mergeOpencodePermission(
  base: OpencodePermission,
  extra: Record<string, Record<string, string>>,
): OpencodePermission {
  const out: OpencodePermission = { ...base };
  for (const [tool, entries] of Object.entries(extra)) {
    const had = out[tool];
    const start: Record<string, string> =
      typeof had === "string" ? { "*": had } : had ? { ...had } : {};
    for (const [pattern, action] of Object.entries(entries)) {
      delete start[pattern];
      start[pattern] = action;
    }
    out[tool] = start;
  }
  return out;
}
