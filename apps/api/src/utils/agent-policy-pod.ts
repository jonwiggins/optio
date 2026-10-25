import { CLAUDE_MANAGED_SETTINGS_PATH, shellQuote } from "@optio/shared";

/**
 * The agent policy's step inside the pod (fork; docs/agent-policy.md), run by
 * every exec script right after the setup files (`WRITE_SETUP_FILES` in
 * pod-env.ts ends with these lines) and before the agent starts.
 *
 * `applyAgentPolicy` (services/agent-policy.ts) decides; the pod does the
 * part that depends on what is already there:
 *
 * - OpenCode: the work may bring its own `OPENCODE_CONFIG_CONTENT` (a pod
 *   secret: the provider for a model inside the network; or
 *   the pod's own env). The policy's rules are merged into it rather than
 *   replacing it, so its provider, model and other keys stay. Its own
 *   `permission` goes over OpenCode's headless block (as OpenCode would merge
 *   the run's `opencode.json` under it), and the policy's deny entries go
 *   last, each tool and pattern moved to the end, because OpenCode takes the
 *   last rule that matches. A value that isn't a JSON object stops the run:
 *   OpenCode would not start without its rules.
 * - Claude Code with no rules: the managed settings an earlier run wrote in
 *   this pod (repo and Job pods serve many runs) are removed, so they don't
 *   outlive the policy. Only a file Optio wrote (its marker,
 *   `managed-settings.json.optio`, sits next to it) and only where the agent
 *   user can write the directory, so an image's own managed settings, or an
 *   image without the directory, are unaffected.
 *
 * The values travel as env so that every exec script needs only these lines.
 * `applyAgentPolicy` sets both for the runtime it concerns, blank when they
 * don't apply, so a pod secret of the same name can't set them.
 */

/** JSON `{ base, deny }`: OpenCode's headless permission block and the policy's deny entries. */
export const OPENCODE_POLICY_ENV = "OPTIO_OPENCODE_POLICY";
/** "1": a Claude Code run with no rules; an earlier run's managed settings are removed. */
export const CLAUDE_POLICY_CLEAR_ENV = "OPTIO_CLAUDE_POLICY_CLEAR";

/** The marker Optio writes next to the managed settings it wrote (`<path>.optio`). */
export function claudePolicyMarkerPath(
  settingsPath: string = CLAUDE_MANAGED_SETTINGS_PATH,
): string {
  return `${settingsPath}.optio`;
}

/** The merge, in Python (every agent image has it: the setup files need it too). */
const MERGE_OPENCODE_CONFIG = [
  `import json, os, sys`,
  `pol = json.loads(os.environ['${OPENCODE_POLICY_ENV}'])`,
  `raw = os.environ.get('OPENCODE_CONFIG_CONTENT', '')`,
  `try:`,
  `    cfg = json.loads(raw) if raw.strip() else {}`,
  `except ValueError:`,
  `    cfg = None`,
  `if not isinstance(cfg, dict):`,
  `    sys.exit('[optio] ERROR: OPENCODE_CONFIG_CONTENT is not a JSON object (no comments or trailing commas), so the agent policy cannot be added to it')`,
  // Its own permission over the headless block: keys keep their places.
  `def over(base, own):`,
  `    out = dict(base)`,
  `    for k, v in own.items():`,
  `        out[k] = {**out[k], **v} if isinstance(v, dict) and isinstance(out.get(k), dict) else v`,
  `    return out`,
  // The policy's deny entries last: each tool and pattern moved to the end.
  `def last(base, deny):`,
  `    out = dict(base)`,
  `    for k, v in deny.items():`,
  `        had = out.pop(k, None)`,
  `        start = {'*': had} if isinstance(had, str) else dict(had) if isinstance(had, dict) else {}`,
  `        for p, a in v.items():`,
  `            start.pop(p, None)`,
  `            start[p] = a`,
  `        out[k] = start`,
  `    return out`,
  `own = cfg.get('permission')`,
  `perm = {'*': own} if isinstance(own, str) else over(pol.get('base') or {}, own if isinstance(own, dict) else {})`,
  `cfg['permission'] = last(perm, pol.get('deny') or {})`,
  `print(json.dumps(cfg))`,
].join("\n");

/** The lines; `claudeSettingsPath` is for tests (the managed settings' real path otherwise). */
export function agentPolicyPodLines(
  claudeSettingsPath: string = CLAUDE_MANAGED_SETTINGS_PATH,
): string[] {
  const file = shellQuote(claudeSettingsPath);
  const marker = shellQuote(claudePolicyMarkerPath(claudeSettingsPath));
  const dir = shellQuote(claudeSettingsPath.slice(0, claudeSettingsPath.lastIndexOf("/")) || "/");
  return [
    `if [ -n "\${${CLAUDE_POLICY_CLEAR_ENV}:-}" ] && [ -w ${dir} ] && [ -e ${marker} ]; then`,
    `  rm -f ${file} ${marker} && echo "[optio] Removed an earlier run's agent policy (this run has no rules)"`,
    `fi`,
    `if [ -n "\${${OPENCODE_POLICY_ENV}:-}" ]; then`,
    `  echo "[optio] Adding the agent policy to OpenCode's config..."`,
    `  _optio_oc="$(python3 -c "${MERGE_OPENCODE_CONFIG}")" || { echo "[optio] ERROR: the agent policy could not be added to OpenCode's config"; exit 1; }`,
    `  export OPENCODE_CONFIG_CONTENT="$_optio_oc"`,
    `  unset _optio_oc`,
    `fi`,
  ];
}

export const AGENT_POLICY_POD_LINES: readonly string[] = agentPolicyPodLines();
