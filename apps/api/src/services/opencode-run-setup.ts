import type { AgentContainerConfig } from "@optio/shared";
import { OPENCODE_GLOBAL_AGENTS_MD, OPENCODE_GLOBAL_AGENTS_MD_PATH } from "@optio/agent-adapters";
import { AGENT_HOME_DIR } from "../utils/harness-config.js";

/**
 * OpenCode's headless rules in every pod run, not only Repo Tasks.
 *
 * The adapter pre-seeds them (packages/agent-adapters opencode.ts: a global
 * `opencode.json` with the permission block, and `AGENTS.md`) only where a
 * worker calls `buildContainerConfig`: Repo Tasks and PR reviews. Job runs,
 * persistent agents' turns and interactive sessions go through
 * `pooledAgentEnv`, which never did, and the run's own `opencode.json`
 * (`OPENCODE_CONFIG`, harness-config.ts `opencodeConfigJson`) used to be
 * written only for a run with MCP servers. Such a run got only
 * `--dangerously-skip-permissions`: questions, `sudo` / `apt` and paths
 * outside its directory were no longer denied, and a model that called
 * OpenCode's question tool waited for an answer nobody could give.
 *
 * So `buildAgentEnvironment` (agent-environment-service.ts), for every
 * OpenCode run:
 *
 * - writes the run's own `opencode.json`, servers or not
 *   (`writesOpencodeRunConfig`): it carries the permission block
 *   (agent-adapters opencode-headless.ts);
 * - adds the global `AGENTS.md` when the adapter hasn't (`withOpencodeRules`),
 *   under the agent's home (`AGENT_HOME_DIR`, /home/agent in every pod).
 */

type SetupFile = NonNullable<AgentContainerConfig["setupFiles"]>[number];

/** Whether a run writes its own `opencode.json` even without MCP servers. */
export function writesOpencodeRunConfig(
  agentType: string | null | undefined,
): agentType is "opencode" {
  return agentType === "opencode";
}

/** Where a pod run's OpenCode reads its global rules. */
export function opencodeRulesPath(): string {
  return `${AGENT_HOME_DIR}/.config/opencode/AGENTS.md`;
}

/** Adds OpenCode's headless rules to an OpenCode run's setup files, once. */
export function withOpencodeRules(
  agentType: string | null | undefined,
  setupFiles: SetupFile[],
): void {
  if (agentType !== "opencode") return;
  const path = opencodeRulesPath();
  if (setupFiles.some((f) => f.path === path || f.path === OPENCODE_GLOBAL_AGENTS_MD_PATH)) return;
  setupFiles.push({ path, content: OPENCODE_GLOBAL_AGENTS_MD });
}
