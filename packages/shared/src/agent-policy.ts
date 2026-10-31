/**
 * Agent policy (docs/agent-policy.md): deny rules an agent gets whatever the
 * repo or the prompt asks.
 *
 * Optio starts Claude Code with its permission checks skipped, and agents
 * read text anyone may write (issue and PR descriptions, review comments,
 * tickets). A policy is a list of Claude Code permission rules
 * (`Read(**\/.env*)`, `Bash(git push --force *)`) written into Claude Code's
 * managed settings, `/etc/claude-code/managed-settings.json`, which a repo's
 * own `.claude/settings.json` can't override and whose deny rules hold in
 * every permission mode. OpenCode gets the same rules in its own syntax.
 *
 * Levels (null = nothing set there):
 *
 * - the deployment: the built-in rules on for every workspace
 *   (`OPTIO_AGENT_POLICY_DEFAULTS`, the operator's; off by default);
 * - the workspace: the built-in rules on for this workspace (it can't turn
 *   off what the deployment turned on), and rules of its own;
 * - a repo: rules added for work in it.
 *
 * A lower level only adds rules; it can't take one away.
 */

/** Where Claude Code reads its managed settings on Linux. */
export const CLAUDE_MANAGED_SETTINGS_PATH = "/etc/claude-code/managed-settings.json";

/** The most rules one level may hold, and the longest rule. */
export const AGENT_POLICY_MAX_RULES = 100;
export const AGENT_POLICY_RULE_MAX_LENGTH = 300;

/**
 * The built-in deny rules: secrets in the checkout and the agent's home,
 * rewriting published history, piping a download into a shell, wiping the
 * pod, and editing the managed settings file itself. Off unless the
 * deployment or a workspace admin turns them on.
 */
export const STANDARD_DENY_RULES: readonly string[] = [
  "Read(**/.env*)",
  "Read(**/*.pem)",
  "Read(**/*.key)",
  "Read(~/.git-credentials)",
  "Read(~/.ssh/**)",
  "Edit(//etc/claude-code/**)",
  // A plain --force only, as a whole flag: --force-with-lease (what Optio's
  // own conflict prompts use on the run's branch) is allowed.
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

/** What one level stores. */
export interface AgentPolicy {
  /** Workspace only: true turns the built-in rules on for this workspace. */
  builtInRules?: boolean;
  /** Claude Code permission rules added to the deny list. */
  denyRules?: string[];
}

export type AgentPolicyLevel = "workspace" | "repo";
export type AgentPolicyRuleSource = "built-in" | AgentPolicyLevel;

export interface AgentPolicyRule {
  rule: string;
  /** Where the rule comes from: the built-in list, or the level that added it. */
  from: AgentPolicyRuleSource;
}

/** The policy a run gets: the built-in rules (when on), its workspace's and its repo's. */
export interface EffectiveAgentPolicy {
  /** Whether the built-in rules apply, and who turned them on. */
  builtInRules: boolean;
  builtInFrom: "deployment" | "workspace" | null;
  /** Every deny rule, each once, the built-in ones first. */
  rules: AgentPolicyRule[];
}

export class AgentPolicyError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "AgentPolicyError";
  }
}

const RULE = /^([A-Za-z][A-Za-z0-9_-]*)(\((.*)\))?$/;
const RUNTIME_CLASS = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;

/** Why `rule` isn't a Claude Code permission rule, or null when it is one. */
export function denyRuleError(rule: string): string | null {
  if (!rule) return "A rule can't be empty";
  if (rule.length > AGENT_POLICY_RULE_MAX_LENGTH) {
    return `"${rule.slice(0, 40)}…" is longer than ${AGENT_POLICY_RULE_MAX_LENGTH} characters`;
  }
  if ([...rule].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)) {
    return `"${rule}" has a line break or a control character`;
  }
  const m = RULE.exec(rule);
  if (!m) {
    return `"${rule}" isn't a permission rule: write a tool, or a tool and what it applies to, such as Read(**/.env*) or Bash(git push --force *)`;
  }
  if (m[2] !== undefined && !m[3]!.trim()) return `"${rule}" has nothing between the brackets`;
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
 * only the fields its level may hold. Throws an `AgentPolicyError` naming
 * every bad rule. An emptied level is `{}`, not null: the row stays, so
 * later runs still clear the file an earlier run wrote (services/agent-policy.ts).
 */
export function cleanAgentPolicy(input: AgentPolicy, level: AgentPolicyLevel): AgentPolicy {
  const errors: string[] = [];
  const rules = [...new Set((input.denyRules ?? []).map((r) => String(r).trim()).filter(Boolean))];
  for (const r of rules) {
    const err = denyRuleError(r);
    if (err) errors.push(err);
  }
  if (rules.length > AGENT_POLICY_MAX_RULES) errors.push(`At most ${AGENT_POLICY_MAX_RULES} rules`);
  if (errors.length > 0) throw new AgentPolicyError(errors.join("; "));
  const out: AgentPolicy = {};
  if (level === "workspace" && input.builtInRules === true) out.builtInRules = true;
  if (rules.length > 0) out.denyRules = rules;
  return out;
}

/** A stored level read leniently: what isn't a valid rule is skipped. */
function storedRules(p: AgentPolicy | null | undefined): string[] {
  return Array.isArray(p?.denyRules)
    ? p.denyRules.filter((r): r is string => typeof r === "string" && denyRuleError(r) === null)
    : [];
}

/** The policy for work in a repo of a workspace. */
export function resolveAgentPolicy(input: {
  /** The deployment's switch for the built-in rules (`OPTIO_AGENT_POLICY_DEFAULTS`). */
  deploymentBuiltIn: boolean;
  workspace?: AgentPolicy | null;
  repo?: AgentPolicy | null;
}): EffectiveAgentPolicy {
  const builtInFrom = input.deploymentBuiltIn
    ? "deployment"
    : input.workspace?.builtInRules === true
      ? "workspace"
      : null;
  const rules: AgentPolicyRule[] = [];
  const seen = new Set<string>();
  const add = (rule: string, from: AgentPolicyRuleSource) => {
    const r = rule.trim();
    if (!r || seen.has(r)) return;
    seen.add(r);
    rules.push({ rule: r, from });
  };
  if (builtInFrom) for (const r of STANDARD_DENY_RULES) add(r, "built-in");
  for (const r of storedRules(input.workspace)) add(r, "workspace");
  for (const r of storedRules(input.repo)) add(r, "repo");
  return { builtInRules: builtInFrom !== null, builtInFrom, rules };
}

/**
 * Claude Code's managed settings for a list of rules: `permissions.deny` and
 * nothing else (an unknown key could make Claude Code reject the file).
 */
export function claudeManagedSettings(rules: readonly string[]): {
  permissions: { deny: string[] };
} {
  return { permissions: { deny: [...rules] } };
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
  return !!m && m[1]! in OPENCODE_TOOL;
}

/**
 * The deny rules as OpenCode `permission` entries: `{ read: { "*.pem": "deny" } }`.
 * No `"*"` entry per tool, so what isn't denied falls to the other config's
 * rules. A bare tool (`Bash`) denies the whole tool.
 */
export function opencodeDenyPermission(
  rules: readonly string[],
): Record<string, Record<string, "deny">> {
  const out: Record<string, Record<string, "deny">> = {};
  for (const rule of rules) {
    const m = RULE.exec(rule.trim());
    if (!m) continue;
    const tool = OPENCODE_TOOL[m[1]!];
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
