import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  AGENT_CREDENTIAL_OPTION_KEY,
  modelProviderIdFrom,
  secretCredentialId,
  secretIdFromCredential,
  type AgentCredential,
  type AgentCredentialInput,
  type AgentCredentialMethod,
  type AgentCredentialMethodOption,
  type AgentCredentialOptions,
  type ClaudeAuthMode,
  type CodexAuthMode,
  type CreateAgentCredentialInput,
  type GeminiAuthMode,
  type ModelProviderAgent,
  type ResourceOwner,
  type VerifyAgentCredentialInput,
  type VerifyAgentCredentialResult,
} from "@optio/shared";
import { db } from "../db/client.js";
import { secrets } from "../db/schema.js";
import { listModelProviders } from "./model-provider-service.js";
import type { Actor } from "./ownership.js";
import { retrieveSecretById, retrieveSecretWithFallback, storeSecret } from "./secret-service.js";

/**
 * Agent credentials: the sign-ins a piece of pod work can run with. The Who
 * section lists them — the organization's secrets of the agent's known names
 * (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `OPENAI_API_KEY`, …), the
 * work owner's own, and the model providers (Bedrock) that serve the agent —
 * and `+` stores a new one. Work picks a secret with
 * `agentOptions.credential = "secret:<row id>"`; the run then gets that value
 * as the env var and the auth mode it implies, over the deployment's
 * `*_AUTH_MODE` default. A provider is still `agentOptions.modelProvider`.
 * See docs/model-providers.md.
 */

export class AgentCredentialError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 = 400,
  ) {
    super(message);
    this.name = "AgentCredentialError";
  }
}

export interface CredentialSpec {
  secretName: string;
  method: AgentCredentialMethod;
  label: string;
  input: AgentCredentialInput;
  /** `verifyAgentCredential` can check a value against the service. */
  verifiable: boolean;
  /** Offered by the `+` modal (Vertex projects come from the setup wizard). */
  addable: boolean;
  hint?: string;
}

const ANTHROPIC_KEY: CredentialSpec = {
  secretName: "ANTHROPIC_API_KEY",
  method: "api-key",
  label: "Anthropic API key",
  input: "token",
  verifiable: true,
  addable: true,
  hint: "From console.anthropic.com → API keys.",
};
const OPENAI_KEY: CredentialSpec = {
  secretName: "OPENAI_API_KEY",
  method: "api-key",
  label: "OpenAI API key",
  input: "token",
  verifiable: true,
  addable: true,
  hint: "From platform.openai.com → API keys.",
};

/** Each agent's sign-in secrets, in picker order. */
const SPECS: Record<string, CredentialSpec[]> = {
  "claude-code": [
    {
      secretName: "CLAUDE_CODE_OAUTH_TOKEN",
      method: "oauth-token",
      label: "Claude subscription (OAuth token)",
      input: "token",
      verifiable: false,
      addable: true,
      hint: "From `claude setup-token` on a machine signed in to Claude.",
    },
    ANTHROPIC_KEY,
    {
      secretName: "CLAUDE_VERTEX_PROJECT_ID",
      method: "vertex-ai",
      label: "Vertex AI project",
      input: "project",
      verifiable: false,
      addable: false,
    },
  ],
  codex: [
    OPENAI_KEY,
    {
      secretName: "CODEX_APP_SERVER_URL",
      method: "app-server",
      label: "Codex app-server",
      input: "url",
      verifiable: false,
      addable: true,
      hint: "The URL of a Codex app-server signed in with a ChatGPT plan.",
    },
  ],
  gemini: [
    {
      secretName: "GEMINI_API_KEY",
      method: "api-key",
      label: "Gemini API key",
      input: "token",
      verifiable: true,
      addable: true,
      hint: "From aistudio.google.com → API keys.",
    },
    {
      secretName: "GOOGLE_CLOUD_PROJECT",
      method: "vertex-ai",
      label: "Vertex AI project",
      input: "project",
      verifiable: false,
      addable: false,
    },
  ],
  copilot: [
    {
      secretName: "COPILOT_GITHUB_TOKEN",
      method: "github-token",
      label: "GitHub token",
      input: "token",
      verifiable: true,
      addable: true,
      hint: "A GitHub token for an account with Copilot.",
    },
  ],
  cursor: [
    {
      secretName: "CURSOR_API_KEY",
      method: "api-key",
      label: "Cursor API key",
      input: "token",
      verifiable: false,
      addable: true,
    },
  ],
  opencode: [
    ANTHROPIC_KEY,
    OPENAI_KEY,
    {
      secretName: "GROQ_API_KEY",
      method: "api-key",
      label: "Groq API key",
      input: "token",
      verifiable: false,
      addable: true,
    },
  ],
  openclaw: [
    {
      secretName: "OPENCLAW_API_KEY",
      method: "api-key",
      label: "OpenClaw API key",
      input: "token",
      verifiable: false,
      addable: true,
    },
  ],
};

/** The deployment secret that holds the agent's default sign-in mode. */
const MODE_SECRET: Record<string, string> = {
  "claude-code": "CLAUDE_AUTH_MODE",
  codex: "CODEX_AUTH_MODE",
  gemini: "GEMINI_AUTH_MODE",
};

/** The auth mode each secret name implies, for the agents that have modes. */
const MODE_OF: Record<string, Record<string, string>> = {
  "claude-code": {
    CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
    ANTHROPIC_API_KEY: "api-key",
    CLAUDE_VERTEX_PROJECT_ID: "vertex-ai",
  },
  codex: { OPENAI_API_KEY: "api-key", CODEX_APP_SERVER_URL: "app-server" },
  gemini: { GEMINI_API_KEY: "api-key", GOOGLE_CLOUD_PROJECT: "vertex-ai" },
};

export function credentialSpecs(agentType: string): CredentialSpec[] {
  return SPECS[agentType] ?? [];
}

export function credentialSpec(agentType: string, secretName: string): CredentialSpec | null {
  return credentialSpecs(agentType).find((s) => s.secretName === secretName) ?? null;
}

function secretNameForMode(agentType: string, mode: string): string | null {
  const modes = MODE_OF[agentType];
  if (!modes) return null;
  return Object.keys(modes).find((name) => modes[name] === mode) ?? null;
}

type SecretRow = typeof secrets.$inferSelect;

function secretCredential(
  row: SecretRow,
  spec: CredentialSpec,
  isDefault: boolean,
): AgentCredential {
  return {
    id: secretCredentialId(row.id),
    kind: "secret",
    method: spec.method,
    label: spec.label,
    secretName: row.name,
    providerId: null,
    owner: row.userId ? "me" : "workspace",
    ownerUserId: row.userId ?? null,
    ownerName: null,
    default: isDefault,
    updatedAt: row.updatedAt?.toISOString() ?? null,
  };
}

/**
 * The secret name a run of this agent uses with no pick: the one the
 * deployment's `*_AUTH_MODE` selects (the owner's own mode first for private
 * work), or null for agents whose first stored secret is the default.
 */
async function defaultSecretName(
  agentType: string,
  workspaceId: string | null,
  ownerUserId: string | null,
): Promise<string | null> {
  const modeSecret = MODE_SECRET[agentType];
  if (!modeSecret) return null;
  const mode =
    (await retrieveSecretWithFallback(modeSecret, "global", workspaceId, ownerUserId).catch(
      () => null,
    )) ?? "api-key";
  return secretNameForMode(agentType, mode);
}

/** The sign-ins `viewer` may give the agent, for work owned by `owner`. */
export async function listAgentCredentials(
  viewer: Actor,
  agentType: string,
  owner: ResourceOwner,
): Promise<AgentCredentialOptions> {
  const specs = credentialSpecs(agentType);
  const addable: AgentCredentialMethodOption[] = specs
    .filter((s) => s.addable)
    .map(({ secretName, method, label, input, verifiable, hint }) => ({
      secretName,
      method,
      label,
      input,
      verifiable,
      hint: hint ?? null,
    }));
  const names = specs.map((s) => s.secretName);
  const orgRows = names.length
    ? await db
        .select()
        .from(secrets)
        .where(
          and(
            inArray(secrets.name, names),
            eq(secrets.scope, "global"),
            isNull(secrets.userId),
            viewer.workspaceId
              ? sql`(${secrets.workspaceId} IS NULL OR ${secrets.workspaceId} = ${viewer.workspaceId})`
              : isNull(secrets.workspaceId),
          ),
        )
    : [];
  const myRows =
    names.length && viewer.userId
      ? await db
          .select()
          .from(secrets)
          .where(
            and(
              inArray(secrets.name, names),
              eq(secrets.scope, "user"),
              eq(secrets.userId, viewer.userId),
            ),
          )
      : [];
  const order = (row: SecretRow) => specs.findIndex((s) => s.secretName === row.name);
  const org = [...orgRows].sort((a, b) => order(a) - order(b));
  const mine = [...myRows].sort((a, b) => order(a) - order(b));

  // The row a run with no pick would use: the owner's own of the default
  // name first (private work), then the organization's.
  const ownerUserId = owner === "me" ? viewer.userId : null;
  const nearest = (name: string) =>
    (owner === "me" ? mine.find((r) => r.name === name) : undefined) ??
    org.find((r) => r.name === name);
  const wanted = await defaultSecretName(agentType, viewer.workspaceId, ownerUserId);
  let fallback = wanted ? nearest(wanted) : undefined;
  if (!fallback && !MODE_SECRET[agentType]) {
    for (const s of specs) {
      fallback = nearest(s.secretName);
      if (fallback) break;
    }
  }
  const toCredential = (row: SecretRow) =>
    secretCredential(row, credentialSpec(agentType, row.name)!, row === fallback);

  const providers = (await listModelProviders(viewer))
    .filter(
      (p) =>
        p.agents.includes(agentType as ModelProviderAgent) &&
        (!p.ownerUserId || p.ownerUserId === viewer.userId),
    )
    .map(
      (p): AgentCredential => ({
        id: `provider:${p.id}`,
        kind: "provider",
        method: "bedrock",
        label: `Amazon Bedrock · ${p.name}`,
        secretName: null,
        providerId: p.id,
        owner: p.ownerUserId ? "me" : "workspace",
        ownerUserId: p.ownerUserId ?? null,
        ownerName: null,
        default: false,
        updatedAt: null,
      }),
    );

  return {
    credentials: [...org.map(toCredential), ...mine.map(toCredential), ...providers],
    addable,
  };
}

/** Store a credential (replacing the owner's existing one of that name) and return it as listed. */
export async function createAgentCredential(
  actor: Actor,
  input: CreateAgentCredentialInput,
): Promise<AgentCredential> {
  const spec = credentialSpec(input.agentType, input.secretName);
  if (!spec || !spec.addable) {
    throw new AgentCredentialError(
      `${input.secretName} isn't a credential ${input.agentType} takes here`,
    );
  }
  const value = input.value.trim();
  if (!value) throw new AgentCredentialError("Enter the value");
  if (spec.input === "url") {
    let ok = false;
    try {
      ok = /^https?:$/.test(new URL(value).protocol);
    } catch {
      ok = false;
    }
    if (!ok) throw new AgentCredentialError("Enter an http(s) URL");
  }
  if (input.owner === "workspace" && !actor.isAdmin) {
    throw new AgentCredentialError("Only admins add organization credentials", 403);
  }
  if (input.owner === "me" && !actor.userId) {
    throw new AgentCredentialError("Sign in to add your own credential", 403);
  }
  if (spec.verifiable && input.verify !== false) {
    const checked = await verifyAgentCredential({
      agentType: input.agentType,
      secretName: input.secretName,
      value,
    });
    if (!checked.valid) {
      throw new AgentCredentialError(checked.error ?? "The service rejected this value");
    }
  }
  if (input.owner === "me") {
    await storeSecret(spec.secretName, value, "user", undefined, actor.userId!);
  } else {
    await storeSecret(spec.secretName, value, "global");
  }
  const listed = await listAgentCredentials(actor, input.agentType, input.owner);
  const made = listed.credentials.find(
    (c) => c.kind === "secret" && c.secretName === spec.secretName && c.owner === input.owner,
  );
  if (!made) throw new Error("The stored credential is not listed");
  return made;
}

type Verifier = (value: string, fetchImpl: typeof fetch) => Promise<VerifyAgentCredentialResult>;

async function fromModelList(res: Response, key: string): Promise<VerifyAgentCredentialResult> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    const list = body[key];
    return { valid: true, detail: Array.isArray(list) ? `${list.length} models` : null };
  }
  const err = body.error as { message?: string } | undefined;
  return { valid: false, error: err?.message ?? `The service answered ${res.status}` };
}

const TIMEOUT_MS = 8_000;

const VERIFIERS: Record<string, Verifier> = {
  ANTHROPIC_API_KEY: async (value, fetchImpl) =>
    fromModelList(
      await fetchImpl("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": value, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      "data",
    ),
  OPENAI_API_KEY: async (value, fetchImpl) =>
    fromModelList(
      await fetchImpl("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${value}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      "data",
    ),
  GEMINI_API_KEY: async (value, fetchImpl) =>
    fromModelList(
      await fetchImpl("https://generativelanguage.googleapis.com/v1beta/models", {
        headers: { "x-goog-api-key": value },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }),
      "models",
    ),
  COPILOT_GITHUB_TOKEN: async (value, fetchImpl) => {
    const res = await fetchImpl("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${value}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = (await res.json().catch(() => ({}))) as { login?: string; message?: string };
    if (res.ok) return { valid: true, detail: body.login ? `@${body.login}` : null };
    return { valid: false, error: body.message ?? `GitHub answered ${res.status}` };
  },
};

/** Check a value against its service without storing it. Never echoes the value. */
export async function verifyAgentCredential(
  input: VerifyAgentCredentialInput,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyAgentCredentialResult> {
  const spec = credentialSpec(input.agentType, input.secretName);
  if (!spec) {
    return {
      valid: false,
      error: `${input.secretName} isn't a credential ${input.agentType} takes`,
    };
  }
  const verifier = VERIFIERS[spec.secretName];
  if (!spec.verifiable || !verifier) return { valid: true, detail: "not checked" };
  const value = input.value.trim();
  if (!value) return { valid: false, error: "Enter the value" };
  try {
    return await verifier(value, fetchImpl);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { valid: false, error: `Could not reach the service: ${reason}` };
  }
}

export interface CredentialUse {
  agentType: string;
  agentOptions: Record<string, unknown> | null | undefined;
  workspaceId: string | null | undefined;
  /** The work's owner (null = the organization). */
  ownerUserId: string | null | undefined;
  runsOn: "pod" | "local";
}

export interface PickedCredential {
  id: string;
  secretName: string;
  method: AgentCredentialMethod;
  label: string;
  value: string;
}

/**
 * The credential a piece of work picks, with its value, checked against who
 * may use it: null when it picks none. Throws an `AgentCredentialError`
 * saying why not (removed, one person's own, not this agent's, a provider
 * picked as well, or work on a machine).
 */
export async function resolveCredentialForWork(
  use: CredentialUse,
): Promise<PickedCredential | null> {
  const raw = use.agentOptions?.[AGENT_CREDENTIAL_OPTION_KEY];
  if (raw === undefined || raw === null || raw === "") return null;
  const id = secretIdFromCredential(raw);
  if (!id) throw new AgentCredentialError('credential must be "secret:<id>"');
  if (modelProviderIdFrom(use.agentOptions)) {
    throw new AgentCredentialError("Pick one sign-in: a credential or a model provider, not both");
  }
  if (use.runsOn === "local") {
    throw new AgentCredentialError(
      "Credentials stay on the server — work on a machine uses the machine's own sign-in",
    );
  }
  const found = await retrieveSecretById(id);
  if (!found) {
    throw new AgentCredentialError("The credential this work uses was removed — pick another");
  }
  const { row, value } = found;
  const spec = credentialSpec(use.agentType, row.name);
  if (!spec) {
    throw new AgentCredentialError(`${row.name} isn't a credential ${use.agentType} takes`);
  }
  if (row.scope === "user") {
    if (!row.userId || row.userId !== (use.ownerUserId ?? null)) {
      throw new AgentCredentialError(
        `"${spec.label}" is one person's own credential — only work they own can use it`,
      );
    }
  } else if (
    row.scope !== "global" ||
    (row.workspaceId && row.workspaceId !== (use.workspaceId ?? null))
  ) {
    throw new AgentCredentialError("The credential this work uses was removed — pick another");
  }
  return {
    id: secretCredentialId(row.id),
    secretName: row.name,
    method: spec.method,
    label: spec.label,
    value,
  };
}

/** A credential pick that is valid for the work, as a 400-able message (or null). */
export async function credentialSelectionError(use: CredentialUse): Promise<string | null> {
  try {
    await resolveCredentialForWork(use);
    return null;
  } catch (err) {
    if (err instanceof AgentCredentialError) return err.message;
    throw err;
  }
}

/** What a run gets for the pick: the env var, and the auth mode it implies. */
export interface CredentialRuntime {
  env: Record<string, string>;
  claudeAuthMode?: ClaudeAuthMode;
  codexAuthMode?: CodexAuthMode;
  codexAppServerUrl?: string;
  geminiAuthMode?: GeminiAuthMode;
}

export function credentialRuntime(
  agentType: string,
  picked: { secretName: string; value: string },
): CredentialRuntime {
  const env = { [picked.secretName]: picked.value };
  const mode = MODE_OF[agentType]?.[picked.secretName];
  switch (agentType) {
    case "claude-code":
      return mode ? { env, claudeAuthMode: mode as ClaudeAuthMode } : { env };
    case "codex":
      if (mode === "app-server") {
        return { env, codexAuthMode: "app-server", codexAppServerUrl: picked.value };
      }
      return { env, codexAuthMode: "api-key" };
    case "gemini":
      return mode ? { env, geminiAuthMode: mode as GeminiAuthMode } : { env };
    default:
      return { env };
  }
}
