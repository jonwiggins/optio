import {
  getAdapter,
  OPENCODE_PLACEHOLDER_KEY,
  OPENCODE_PROVIDER_KEYS,
} from "@optio/agent-adapters";
import { agentOptionsEnv } from "./agent-options-env.js";
import { podProviderRuntime, resolveProviderForWork } from "./model-provider-service.js";
import {
  credentialRuntime,
  resolveCredentialForWork,
  type CredentialRuntime,
} from "./agent-credential-service.js";
import { resolveSecretsForTask, retrieveSecretWithFallback } from "./secret-service.js";

/**
 * What an agent needs in a pooled pod — for a Job run or a persistent
 * agent's turn — to run `buildPooledAgentCommand`: its sign-in (an API key,
 * an OAuth token, the deployment's Max subscription, or the model provider
 * the work picked) and its parameters (model, effort, approval mode, …) as
 * the env the command builder reads. The prompt travels as `OPTIO_PROMPT`.
 */
export async function pooledAgentEnv(
  agent: {
    agentRuntime: string;
    agentOptions: Record<string, string | boolean> | null;
    model?: string | null;
  },
  prompt: string,
  workspaceId: string | null,
  ownerUserId: string | null,
): Promise<Record<string, string>> {
  const adapter = getAdapter(agent.agentRuntime);
  // A model provider (Bedrock) picked for the work replaces the agent's own
  // sign-in: no Anthropic / OpenAI key is needed then.
  const providerRow = await resolveProviderForWork({
    agentType: agent.agentRuntime,
    agentOptions: agent.agentOptions,
    workspaceId,
    ownerUserId,
    runsOn: "pod",
  });
  const providerRuntime = providerRow ? podProviderRuntime(providerRow, agent.agentRuntime) : null;
  const secret = (name: string) =>
    retrieveSecretWithFallback(name, "global", workspaceId, ownerUserId).catch(
      () => null,
    ) as Promise<string | null>;
  const resolvedSecrets = providerRuntime
    ? {}
    : await pooledProviderSecrets(adapter, agent, secret, (names) =>
        resolveSecretsForTask(names, "", workspaceId, ownerUserId),
      );
  const claudeAuthMode = providerRuntime
    ? "bedrock"
    : ((await secret("CLAUDE_AUTH_MODE")) ?? "api-key");

  const env: Record<string, string> = {
    ...resolvedSecrets,
    ...(providerRuntime?.env ?? {}),
    ...(providerRuntime?.codexConfig.length
      ? { OPTIO_CODEX_PROVIDER_CONFIG: JSON.stringify(providerRuntime.codexConfig) }
      : {}),
    OPTIO_PROMPT: prompt,
    OPTIO_AGENT_TYPE: agent.agentRuntime,
    OPTIO_AUTH_MODE: claudeAuthMode,
    // `model` is the legacy field.
    ...agentOptionsEnv(agent.agentRuntime, agent.agentOptions, agent.model),
  };

  // OpenCode's custom endpoint: what the adapter puts in a Repo Task's env,
  // for the pooled command that reads the same variables.
  if (agent.agentRuntime === "opencode" && env.OPTIO_OPENCODE_BASE_URL) {
    env.OPENAI_BASE_URL = env.OPTIO_OPENCODE_BASE_URL;
    env.OPENAI_API_KEY ||= OPENCODE_PLACEHOLDER_KEY;
  }
  if (claudeAuthMode === "api-key") {
    const apiKey = await secret("ANTHROPIC_API_KEY");
    if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  }
  if (claudeAuthMode === "oauth-token") {
    const oauthToken = await secret("CLAUDE_CODE_OAUTH_TOKEN");
    if (!oauthToken) {
      throw new Error("OAuth token mode selected but no CLAUDE_CODE_OAUTH_TOKEN secret found");
    }
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  if (claudeAuthMode === "max-subscription") {
    const { getClaudeAuthToken } = await import("./auth-service.js");
    const authResult = getClaudeAuthToken();
    if (!authResult.available || !authResult.token) {
      throw new Error(`Max subscription auth failed: ${authResult.error ?? "Token not available"}`);
    }
    env.CLAUDE_CODE_OAUTH_TOKEN = authResult.token;
  }
  // The picked credential is this work's explicit choice: it beats everything above.
  if (credential) {
    Object.assign(env, credential.env);
    if (credential.codexAuthMode) env.OPTIO_CODEX_AUTH_MODE = credential.codexAuthMode;
    if (credential.codexAppServerUrl) env.OPTIO_CODEX_APP_SERVER_URL = credential.codexAppServerUrl;
  }
  return env;
}

/**
 * The sign-in secrets a pooled agent needs. Every adapter but OpenCode names
 * each one (`validateSecrets([]).missing`, resolved with `resolveRequired`,
 * which throws for a name that is not stored). OpenCode takes any one
 * provider key, or none at all with a custom base URL — a rule that contract
 * cannot express, which is why its `missing` reads "A or B".
 */
export async function pooledProviderSecrets(
  adapter: { validateSecrets(available: string[]): { missing: string[] } },
  agent: { agentRuntime: string; agentOptions: Record<string, string | boolean> | null },
  secret: (name: string) => Promise<string | null>,
  resolveRequired: (names: string[]) => Promise<Record<string, string>>,
): Promise<Record<string, string>> {
  if (agent.agentRuntime !== "opencode") {
    return resolveRequired(adapter.validateSecrets([]).missing);
  }
  const found: Record<string, string> = {};
  for (const name of OPENCODE_PROVIDER_KEYS) {
    const value = await secret(name);
    if (value) found[name] = value;
  }
  const baseUrl = agent.agentOptions?.opencodeBaseUrl;
  if (Object.keys(found).length === 0 && !(typeof baseUrl === "string" && baseUrl)) {
    const keys = [...OPENCODE_PROVIDER_KEYS];
    throw new Error(
      `OpenCode needs one of ${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]} as a secret, or a custom base URL (opencodeBaseUrl)`,
    );
  }
  return found;
}
