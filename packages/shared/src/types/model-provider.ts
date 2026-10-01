/**
 * Model providers: a saved way for an agent CLI to reach its models other
 * than its default sign-in — today Amazon Bedrock, for Claude Code and Codex.
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

export type ModelProviderKind = "bedrock";

/** The agent runtimes a model provider can serve. */
export const MODEL_PROVIDER_AGENTS = ["claude-code", "codex"] as const;
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

export interface ModelProviderModel {
  /** The provider's model id, passed to the CLI as-is. */
  id: string;
  /** Shown in pickers; the id when absent. */
  label?: string;
}

/** The models a provider offers each agent, in picker order; the first is the default. */
export interface ModelProviderModels {
  "claude-code"?: ModelProviderModel[];
  codex?: ModelProviderModel[];
}

/** Who a model provider, secret, connection or piece of work belongs to. */
export type ResourceOwner = "workspace" | "me";

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
  /** AWS region the runtime calls (`us-west-2`). */
  region: string;
  /** The models offered for each agent, in picker order; the first is the default. */
  models: ModelProviderModels;
  /** AWS profile to use on a machine; null = the machine's default AWS credentials. */
  localAwsProfile: string | null;
  podCredential: ModelProviderPodCredential;
  /** Whether stored pod credentials exist (the values are never returned). */
  hasPodCredentials: boolean;
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
  region: string;
  models?: ModelProviderModels;
  localAwsProfile?: string | null;
  podCredential?: ModelProviderPodCredential;
  /** Replaces the stored pod credentials; null clears them; absent keeps them. */
  credentials?: ModelProviderCredentials | null;
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
}

/**
 * What a spawn on a machine carries to use a provider: never a credential,
 * only where to call and which of the machine's AWS profiles to use.
 */
export interface ModelProviderLaunch {
  kind: ModelProviderKind;
  providerId: string;
  name: string;
  region: string;
  /** An AWS profile on the machine; absent = its default credentials. */
  awsProfile?: string;
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

/** Whether `role` may create or change organization-owned resources. */
export function canManageOrgResources(role: WorkspaceRole | null | undefined): boolean {
  return role === "admin";
}
