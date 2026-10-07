import type { ResourceOwner } from "./model-provider.js";

/**
 * Agent credentials: how an agent CLI signs in for a piece of pod work. A
 * credential is one of the agent's known sign-in secrets (an Anthropic API
 * key, a Claude OAuth token, an OpenAI key, a Codex app-server URL, …) or a
 * model provider (Amazon Bedrock). The Who section lists the ones the work
 * may use — the organization's and the work owner's own — and `+` adds one.
 *
 * Work picks a secret credential with `agentOptions.credential = "secret:<id>"`
 * (`AGENT_CREDENTIAL_OPTION_KEY`); a provider is still picked with
 * `agentOptions.modelProvider = <id>`. Neither set = the agent's usual
 * sign-in (the deployment's `*_AUTH_MODE` and the nearest secret of that
 * name). Work on a machine takes none of it: the machine's own CLI login.
 */

/** How the credential signs the agent in. */
export type AgentCredentialMethod =
  | "api-key"
  | "oauth-token"
  | "app-server"
  | "github-token"
  | "vertex-ai"
  | "bedrock";

export type AgentCredentialKind = "secret" | "provider";

/** What the `+` modal asks for. */
export type AgentCredentialInput = "token" | "url" | "project";

export interface AgentCredential {
  /** `secret:<secret row id>` or `provider:<model provider id>`. */
  id: string;
  kind: AgentCredentialKind;
  method: AgentCredentialMethod;
  /** "Anthropic API key", "Claude subscription (OAuth token)", "Amazon Bedrock · Acme prod". */
  label: string;
  /** The secret's name (`kind: "secret"`). */
  secretName?: string | null;
  /** The provider's id (`kind: "provider"`): what `agentOptions.modelProvider` takes. */
  providerId?: string | null;
  /** The organization's, or one person's own. */
  owner: ResourceOwner;
  ownerUserId?: string | null;
  ownerName?: string | null;
  /** What a run of this work would use with no pick. */
  default: boolean;
  updatedAt?: string | null;
}

/** One way to add a credential for the agent: an entry of the `+` modal. */
export interface AgentCredentialMethodOption {
  secretName: string;
  method: AgentCredentialMethod;
  label: string;
  input: AgentCredentialInput;
  /** Whether `POST /api/agents/credentials` can check the value against the service first. */
  verifiable: boolean;
  /** A sentence under the field: where to get it. */
  hint?: string | null;
}

/** `GET /api/agents/credentials?agentType=&owner=`. */
export interface AgentCredentialOptions {
  credentials: AgentCredential[];
  /** Methods the `+` modal offers for this agent (Bedrock is added through Settings → Model providers). */
  addable: AgentCredentialMethodOption[];
}

/** `POST /api/agents/credentials`: stores the secret and returns the credential. */
export interface CreateAgentCredentialInput {
  agentType: string;
  secretName: string;
  value: string;
  /** `workspace` needs an admin; `me` any member. */
  owner: ResourceOwner;
  /** Check the value against the service before storing (default true where possible). */
  verify?: boolean;
}

/** `POST /api/agents/credentials/verify`: checks a value without storing it. */
export interface VerifyAgentCredentialInput {
  agentType: string;
  secretName: string;
  value: string;
}

export interface VerifyAgentCredentialResult {
  valid: boolean;
  /** Why not, in a sentence. */
  error?: string | null;
  /** What the check learned ("3 models", "@octocat"). */
  detail?: string | null;
}

/** The `agentOptions` key that holds a picked secret credential. */
export const AGENT_CREDENTIAL_OPTION_KEY = "credential";

/** The `agentOptions.credential` value for a secret row. */
export function secretCredentialId(secretId: string): string {
  return `secret:${secretId}`;
}

/** The secret row id a `credential` value names, or null when it is not a secret credential. */
export function secretIdFromCredential(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^secret:([0-9a-f-]{36})$/i.exec(value.trim());
  return m ? m[1] : null;
}
