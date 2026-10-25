/**
 * Model providers: a saved way for an agent CLI to reach its models other
 * than its default sign-in — Amazon Bedrock, for Claude Code and Codex, or
 * a model gateway (LiteLLM, OpenRouter, Portkey or any OpenAI- /
 * Anthropic-compatible endpoint; docs/model-gateway.md).
 *
 * Set up once (Settings → Model providers), owned by the organization (the
 * workspace) or by one person, then picked per piece of work: the work's
 * agent options carry `modelProvider: <id>` and the model field holds the
 * provider's own model id (`us.anthropic.claude-opus-5-5`, `openai.gpt-5.4`).
 *
 * Where the run happens decides the credentials:
 * - a pod uses what the provider stores on the server (AWS access keys or a
 *   Bedrock API key, encrypted) or the pod's own IAM role (`ambient`);
 * - a machine uses its own AWS credentials (an AWS profile there, by name).
 *   No credential ever leaves the server for a machine.
 */

import type { WorkspaceRole } from "./workspace.js";
import { currentFeatures, type DeploymentFeatures } from "../config/features.js";

/**
 * `bedrock`: upstream's Amazon Bedrock. `gateway`: an Anthropic- /
 * OpenAI-compatible model gateway of one of the `ModelGatewayType`s
 * (model-gateways.ts), the one kind a gateway-only deployment offers
 * (`offeredModelProviderKinds`).
 */
export type ModelProviderKind = "bedrock" | "gateway";

export const MODEL_PROVIDER_KINDS: readonly ModelProviderKind[] = ["bedrock", "gateway"];

export function isModelProviderKind(kind: string): kind is ModelProviderKind {
  return (MODEL_PROVIDER_KINDS as readonly string[]).includes(kind);
}

/** The provider kinds the deployment offers: the gateway alone with `OPTIO_MODEL_ACCESS=gateway`. */
export function offeredModelProviderKinds(
  features: DeploymentFeatures = currentFeatures(),
): ModelProviderKind[] {
  return features.modelAccess === "gateway" ? ["gateway"] : [...MODEL_PROVIDER_KINDS];
}

/**
 * What a model gateway is (docs/model-gateway.md "Gateway types"): LiteLLM,
 * OpenRouter, Portkey, or any OpenAI- / Anthropic-compatible endpoint
 * (`generic`). Its features: `modelGatewayCapabilities` (model-gateways.ts).
 */
export type ModelGatewayType = "generic" | "litellm" | "openrouter" | "portkey";

/** The agent runtimes a model provider can serve. */
export const MODEL_PROVIDER_AGENTS = ["claude-code", "codex", "opencode"] as const;
export type ModelProviderAgent = (typeof MODEL_PROVIDER_AGENTS)[number];

export function isModelProviderAgent(agentType: string): agentType is ModelProviderAgent {
  return (MODEL_PROVIDER_AGENTS as readonly string[]).includes(agentType);
}

/**
 * How a pod signs in to the provider:
 * - `access-key`: stored AWS access key id + secret (+ optional session token)
 * - `bearer-token`: a stored Bedrock API key (`AWS_BEARER_TOKEN_BEDROCK`)
 * - `ambient`: the pod's own AWS identity (IRSA / instance profile on EKS)
 * - `none`: machines only — work in a pod can't use it
 */
export type ModelProviderPodCredential = "access-key" | "bearer-token" | "ambient" | "none";

export const MODEL_PROVIDER_POD_CREDENTIALS: readonly ModelProviderPodCredential[] = [
  "access-key",
  "bearer-token",
  "ambient",
  "none",
];

/** Which of Claude Code's built-in aliases a gateway model stands in for. */
export type ModelProviderModelRole = "opus" | "sonnet" | "haiku";

export const MODEL_PROVIDER_MODEL_ROLES: readonly ModelProviderModelRole[] = [
  "opus",
  "sonnet",
  "haiku",
];

/** What the organization pays its gateway, in USD per million tokens. */
export interface ModelProviderPrices {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelProviderModel {
  /** The provider's model id, passed to the CLI as-is. */
  id: string;
  /** Shown in pickers; the id when absent. */
  label?: string;
  /** Gateway: the model's context window in tokens (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`). */
  contextWindow?: number;
  /** Gateway: the longest answer, in tokens (`CLAUDE_CODE_MAX_OUTPUT_TOKENS`). */
  maxOutputTokens?: number;
  /** Gateway: the effort levels the model takes; absent = none offered. */
  efforts?: string[];
  /** Gateway: the effort used when the work picks none. */
  defaultEffort?: string;
  /** Gateway: prices, for the Usage page's estimates. */
  prices?: ModelProviderPrices;
  /** Gateway: the Claude Code alias this model stands in for. */
  role?: ModelProviderModelRole;
  /** Gateway: the last catalog sync didn't find it; kept so old work still names it. */
  missing?: boolean;
}

/** The models a provider offers each agent, in picker order; the first is the default. */
export interface ModelProviderModels {
  "claude-code"?: ModelProviderModel[];
  codex?: ModelProviderModel[];
  opencode?: ModelProviderModel[];
}

/**
 * How a gateway expects its token: `bearer` → `ANTHROPIC_AUTH_TOKEN` and
 * `Authorization: Bearer`; `api-key` → `ANTHROPIC_API_KEY` and `x-api-key`.
 */
export type ModelProviderAuthHeader = "bearer" | "api-key";

export const MODEL_PROVIDER_AUTH_HEADERS: readonly ModelProviderAuthHeader[] = [
  "bearer",
  "api-key",
];

/**
 * Where a gateway run's token comes from: `personal` — the owner's own
 * secret (a person's, a team's or the organization's; the default, so the
 * gateway's spend ledger stays per person); `stored` — one shared token
 * sealed on the provider (`podCredential: "bearer-token"`).
 */
export type ModelProviderTokenSource = "personal" | "stored";

export const MODEL_PROVIDER_TOKEN_SOURCES: readonly ModelProviderTokenSource[] = [
  "personal",
  "stored",
];

/**
 * Who a model provider, secret, connection or piece of work belongs to: the
 * organization (`workspace`), the caller (`me`), or one of their teams
 * (`team:<id>`; `teamOwner` / `teamIdOf` in types/team.ts).
 */
export type ResourceOwner = "workspace" | "me" | `team:${string}`;

export interface ModelProvider {
  id: string;
  workspaceId: string | null;
  /** Null = the organization's (every member can pick it). Set = one person's own. */
  ownerUserId: string | null;
  /** Display name of `ownerUserId`, for personal providers. */
  ownerName: string | null;
  kind: ModelProviderKind;
  name: string;
  agents: ModelProviderAgent[];
  /** AWS region the runtime calls (`us-west-2`); empty for a gateway. */
  region: string;
  /** The models offered for each agent, in picker order; the first is the default. */
  models: ModelProviderModels;
  /** AWS profile to use on a machine; null = the machine's default AWS credentials. */
  localAwsProfile: string | null;
  podCredential: ModelProviderPodCredential;
  /** Whether stored pod credentials exist (the values are never returned). */
  hasPodCredentials: boolean;
  /**
   * Gateway: what it is (model-gateways.ts), which decides the gateway
   * features it offers; null for Bedrock. Absent reads as `litellm`.
   */
  gatewayType?: ModelGatewayType | null;
  /** Gateway: where it listens (`https://litellm.example.com`, no trailing slash). */
  baseUrl: string | null;
  /** Gateway: how it takes the token. */
  authHeader: ModelProviderAuthHeader;
  /**
   * Gateway: where its management API answers when that isn't `baseUrl`
   * (LiteLLM's `/model/info` and key routes; Portkey's control plane).
   */
  syncUrl: string | null;
  /** Gateway: when the catalog was last synced. */
  lastSyncedAt: string | null;
  /** Gateway: whose token a run gets. */
  tokenSource: ModelProviderTokenSource;
  /** The viewer's own (personal) provider. */
  mine: boolean;
  /** Whether the viewer may change or delete it. */
  canEdit: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ModelProviderCredentials =
  | { type: "access-key"; accessKeyId: string; secretAccessKey: string; sessionToken?: string }
  | { type: "bearer-token"; bearerToken: string };

export interface CreateModelProviderInput {
  name: string;
  /** `workspace` needs an admin. */
  owner: ResourceOwner;
  kind: ModelProviderKind;
  agents: ModelProviderAgent[];
  /** Bedrock's AWS region; a gateway has none. */
  region?: string;
  models?: ModelProviderModels;
  localAwsProfile?: string | null;
  podCredential?: ModelProviderPodCredential;
  /** Replaces the stored pod credentials; null clears them; absent keeps them. */
  credentials?: ModelProviderCredentials | null;
  /** Gateway: what it is; `litellm` by default (`DEFAULT_MODEL_GATEWAY_TYPE`). */
  gatewayType?: ModelGatewayType;
  /** Gateway: where it listens (required for `kind: "gateway"`). */
  baseUrl?: string;
  /** Gateway: how it takes the token; `bearer` by default. */
  authHeader?: ModelProviderAuthHeader;
  syncUrl?: string | null;
  /** Gateway: `personal` by default; `stored` needs `credentials` (a bearer token). */
  tokenSource?: ModelProviderTokenSource;
}

/** A change to a model provider: absent fields are kept. */
export interface UpdateModelProviderInput {
  name?: string;
  /** Moving it to the organization needs an admin. */
  owner?: ResourceOwner;
  agents?: ModelProviderAgent[];
  region?: string;
  models?: ModelProviderModels;
  localAwsProfile?: string | null;
  podCredential?: ModelProviderPodCredential;
  /** Replaces the stored pod credentials; null clears them; absent keeps them. */
  credentials?: ModelProviderCredentials | null;
  /** Refused while keys Optio made on the gateway are still active. */
  gatewayType?: ModelGatewayType;
  baseUrl?: string;
  authHeader?: ModelProviderAuthHeader;
  syncUrl?: string | null;
  tokenSource?: ModelProviderTokenSource;
}

/**
 * What a spawn on a machine carries to use a provider. Bedrock: never a
 * credential, only where to call and which of the machine's AWS profiles to
 * use. A gateway: the full env (`gatewayRuntime`), token included — it is
 * the owner's own token going to their own machine (docs/model-gateway.md).
 */
export interface ModelProviderLaunch {
  kind: ModelProviderKind;
  providerId: string;
  name: string;
  /** Bedrock's region; empty for a gateway. */
  region: string;
  /** An AWS profile on the machine; absent = its default credentials. */
  awsProfile?: string;
  /** Gateway: where it listens. */
  baseUrl?: string;
  /** Gateway: how it takes the token. */
  authHeader?: ModelProviderAuthHeader;
  /** Gateway: the env the agent CLI runs with (`gatewayRuntime`). */
  env?: Record<string, string>;
  /**
   * Gateway: the served models with their prices, for the machine's usage
   * tracker (`priceForModel`'s catalog) — ids and prices only.
   */
  models?: ModelProviderModel[];
}

/** The agent-options key that selects a model provider for a run. */
export const MODEL_PROVIDER_OPTION_KEY = "modelProvider";

/** The provider a run's agent options pick, if any. */
export function modelProviderIdFrom(
  agentOptions: Record<string, unknown> | null | undefined,
): string | undefined {
  const v = agentOptions?.[MODEL_PROVIDER_OPTION_KEY];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

const AWS_REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d+$/;
const AWS_PROFILE_RE = /^[A-Za-z0-9._+=@-]{1,64}$/;

export function isValidAwsRegion(region: string): boolean {
  return AWS_REGION_RE.test(region);
}

export function isValidAwsProfileName(name: string): boolean {
  return AWS_PROFILE_RE.test(name);
}

/**
 * The cross-region inference prefix Bedrock uses for Anthropic models in a
 * region (`us.anthropic.…` from us-west-2).
 */
export function bedrockInferencePrefix(region: string): string {
  if (region.startsWith("us-gov-")) return "us-gov";
  if (region.startsWith("us-") || region.startsWith("ca-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region.startsWith("ap-")) return "apac";
  return "global";
}

/** Suggested models for a new Bedrock provider (editable in Settings). */
export function bedrockDefaultModels(
  agent: ModelProviderAgent,
  region: string,
): ModelProviderModel[] {
  if (agent === "codex") {
    return [
      { id: "openai.gpt-5.5", label: "GPT-5.5" },
      { id: "openai.gpt-5.4", label: "GPT-5.4" },
    ];
  }
  const p = bedrockInferencePrefix(region);
  return [
    { id: `${p}.anthropic.claude-opus-5-5`, label: "Opus 5.5" },
    { id: `${p}.anthropic.claude-sonnet-5`, label: "Sonnet 5" },
    { id: `${p}.anthropic.claude-fable-5-1`, label: "Fable 5.1" },
    { id: `${p}.anthropic.claude-haiku-4-5-20251001-v1:0`, label: "Haiku 4.5" },
  ];
}

/**
 * The env and Codex config overrides that point an agent CLI at Bedrock.
 * One mapping for both run locations: the daemon calls it with the launch
 * (a machine AWS profile), the pod workers with the stored credentials.
 *
 * - Claude Code: `CLAUDE_CODE_USE_BEDROCK=1` + `AWS_REGION` (it doesn't read
 *   the region from ~/.aws/config).
 * - Codex: its built-in `amazon-bedrock` provider (`-c model_provider=…`),
 *   which reads `AWS_REGION` and the standard AWS credential chain.
 */
export function bedrockRuntime(
  agent: ModelProviderAgent,
  launch: Pick<ModelProviderLaunch, "region" | "awsProfile">,
  credentials?: ModelProviderCredentials | null,
): { env: Record<string, string>; codexConfig: string[] } {
  const env: Record<string, string> = {
    AWS_REGION: launch.region,
    AWS_DEFAULT_REGION: launch.region,
  };
  if (launch.awsProfile) env.AWS_PROFILE = launch.awsProfile;
  if (credentials?.type === "access-key") {
    env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    if (credentials.sessionToken) env.AWS_SESSION_TOKEN = credentials.sessionToken;
  } else if (credentials?.type === "bearer-token") {
    env.AWS_BEARER_TOKEN_BEDROCK = credentials.bearerToken;
  }
  if (agent === "claude-code") {
    env.CLAUDE_CODE_USE_BEDROCK = "1";
    return { env, codexConfig: [] };
  }
  return { env, codexConfig: ['model_provider="amazon-bedrock"'] };
}

// ── Model gateway (docs/model-gateway.md) ────────────────────────────────────

/** What `gatewayRuntime` needs to know about a gateway. */
export interface GatewayRuntimeSource {
  /** Absent = `litellm` (`DEFAULT_MODEL_GATEWAY_TYPE`). */
  type?: ModelGatewayType;
  baseUrl: string;
  authHeader: ModelProviderAuthHeader;
  models: ModelProviderModels;
}

/** The model a run picked from the gateway's catalog, and its effort if any. */
export interface GatewayModelPick {
  model: string;
  effort?: string;
}

/** The env name Claude Code reads the gateway's token from, per the auth header. */
export function gatewayTokenEnvName(
  authHeader: ModelProviderAuthHeader,
): "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" {
  return authHeader === "api-key" ? "ANTHROPIC_API_KEY" : "ANTHROPIC_AUTH_TOKEN";
}

/**
 * The name of the secret that holds a person's / team's / organization's
 * gateway token: what Claude Code reads it as (`ANTHROPIC_AUTH_TOKEN`, or
 * `ANTHROPIC_API_KEY` for an `api-key` gateway). A gateway that serves
 * OpenCode alone names it `OPENAI_API_KEY`; one serving both takes the one
 * token under the Claude name and hands it to OpenCode as `OPENAI_API_KEY`.
 */
export function gatewayTokenSecretName(gateway: {
  authHeader: ModelProviderAuthHeader;
  agents?: readonly string[];
}): "ANTHROPIC_AUTH_TOKEN" | "ANTHROPIC_API_KEY" | "OPENAI_API_KEY" {
  const agents = gateway.agents ?? [];
  if (agents.length > 0 && agents.every((a) => a === "opencode")) return "OPENAI_API_KEY";
  return gatewayTokenEnvName(gateway.authHeader);
}

/** `baseUrl` without a trailing slash (what the env carries). */
export function normalizeGatewayBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/** Whether `url` is an `http(s)://` URL with a host and no trailing slash. */
export function isValidGatewayUrl(url: string): boolean {
  if (!/^https?:\/\/[^\s/]+/i.test(url) || url.endsWith("/")) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The env that points an agent CLI at the gateway, for pods and machines
 * alike — the table in docs/model-gateway.md.
 *
 * - Claude Code: `ANTHROPIC_BASE_URL` + the token under the auth header's
 *   name; the picked model as `ANTHROPIC_MODEL` and the subagent model; each
 *   built-in alias (`ANTHROPIC_DEFAULT_OPUS_MODEL` …) as the catalog model
 *   with that `role`, else the pick, so a background task never asks for an
 *   id the gateway doesn't serve; the model's output and context limits;
 *   and the switches that keep every byte inside the network.
 * - OpenCode: the gateway's OpenAI-compatible `/v1` with the same token as
 *   `OPENAI_API_KEY`, and the model as `OPTIO_OPENCODE_MODEL`.
 *
 * Per gateway type, as each documents its Claude Code setup: Portkey also
 * gets the token as its own `x-portkey-api-key` header
 * (`ANTHROPIC_CUSTOM_HEADERS`). OpenRouter asks that no `ANTHROPIC_API_KEY`
 * be set beside `ANTHROPIC_AUTH_TOKEN`, which every gateway run already
 * ensures (`applyGatewayEnv` in pods, the daemon's unset list on machines).
 *
 * `token` null leaves the token out (a launch the machine completes itself).
 */
export function gatewayRuntime(
  agent: ModelProviderAgent,
  gateway: GatewayRuntimeSource,
  pick: GatewayModelPick,
  token: string | null,
): { env: Record<string, string>; codexConfig: string[] } {
  const baseUrl = normalizeGatewayBaseUrl(gateway.baseUrl);
  const env: Record<string, string> = {};
  if (agent === "opencode") {
    env.OPENAI_BASE_URL = `${baseUrl}/v1`;
    if (token) env.OPENAI_API_KEY = token;
    env.OPTIO_OPENCODE_MODEL = pick.model;
    return { env, codexConfig: [] };
  }
  const models = gateway.models[agent] ?? [];
  const picked = models.find((m) => m.id === pick.model);
  env.ANTHROPIC_BASE_URL = baseUrl;
  if (token) env[gatewayTokenEnvName(gateway.authHeader)] = token;
  if (gateway.type === "portkey" && token) {
    env.ANTHROPIC_CUSTOM_HEADERS = `x-portkey-api-key: ${token}`;
  }
  env.ANTHROPIC_MODEL = pick.model;
  env.CLAUDE_CODE_SUBAGENT_MODEL = pick.model;
  for (const role of MODEL_PROVIDER_MODEL_ROLES) {
    const stand = models.find((m) => m.role === role && !m.missing);
    env[`ANTHROPIC_DEFAULT_${role.toUpperCase()}_MODEL`] = stand?.id ?? pick.model;
  }
  if (picked?.maxOutputTokens && picked.maxOutputTokens > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(Math.floor(picked.maxOutputTokens));
  }
  // Every window is told to Claude Code: for an id it doesn't know it assumes
  // 200k, and a smaller model behind the gateway would overflow before it
  // compacts (2.1.308 honours 32k). A `claude-…` id keeps Anthropic's window
  // whatever this says (docs/model-gateway.md, "Model names").
  if (picked?.contextWindow && picked.contextWindow > 0) {
    const window = String(Math.floor(picked.contextWindow));
    env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = window;
    env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = window;
  }
  if (pick.effort && picked?.efforts?.includes(pick.effort)) {
    env.CLAUDE_CODE_EFFORT_LEVEL = pick.effort;
  }
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  env.DISABLE_AUTOUPDATER = "1";
  env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
  return { env, codexConfig: [] };
}

/** The agent-options key that holds the model for an agent a gateway serves. */
export function gatewayModelOptionKey(agent: ModelProviderAgent): string {
  return agent === "opencode"
    ? "opencodeModel"
    : agent === "codex"
      ? "copilotModel"
      : "claudeModel";
}

/**
 * The model a piece of work picks from a gateway's catalog for `agent` —
 * `agentOptions.claudeModel` (or the agent's own key), else the first model
 * the gateway still serves — and the effort, when the model takes it (the
 * work's `claudeEffort`, else the model's default). Null when the gateway
 * serves nothing for the agent.
 */
export function gatewayModelPick(
  gateway: Pick<GatewayRuntimeSource, "models">,
  agent: ModelProviderAgent,
  agentOptions: Record<string, unknown> | null | undefined,
): GatewayModelPick | null {
  const models = gateway.models[agent] ?? [];
  const wanted = agentOptions?.[gatewayModelOptionKey(agent)];
  const id =
    typeof wanted === "string" && wanted.trim()
      ? wanted.trim()
      : (models.find((m) => !m.missing) ?? models[0])?.id;
  if (!id) return null;
  const model = models.find((m) => m.id === id);
  const askedEffort = agentOptions?.claudeEffort;
  const effort =
    typeof askedEffort === "string" && model?.efforts?.includes(askedEffort)
      ? askedEffort
      : model?.defaultEffort;
  return effort ? { model: id, effort } : { model: id };
}

/** Whether `role` may create or change organization-owned resources. */
export function canManageOrgResources(role: WorkspaceRole | null | undefined): boolean {
  return role === "admin";
}
