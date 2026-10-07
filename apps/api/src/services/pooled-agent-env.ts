import { getAdapter } from "@optio/agent-adapters";
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
  const resolvedSecrets = providerRuntime
    ? {}
    : await resolveSecretsForTask(
        adapter.validateSecrets([]).missing,
        "",
        workspaceId,
        ownerUserId,
      );
  const secret = (name: string) =>
    retrieveSecretWithFallback(name, "global", workspaceId, ownerUserId).catch(
      () => null,
    ) as Promise<string | null>;
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
