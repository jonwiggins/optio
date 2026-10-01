import {
  bedrockDefaultModels,
  isValidAwsProfileName,
  isValidAwsRegion,
  MODEL_PROVIDER_AGENTS,
  type CreateModelProviderInput,
  type ModelProvider,
  type ModelProviderAgent,
  type ModelProviderCredentials,
  type ModelProviderModel,
  type ModelProviderPodCredential,
  type ResourceOwner,
  type UpdateModelProviderInput,
} from "@optio/shared";

/**
 * The Settings → Model providers editor's state, and its round trip to the
 * API's create / update bodies. Credentials are write-only: an existing
 * provider shows "Stored" and keeps them unless you Replace or Clear.
 */

export const AGENT_LABELS: Record<ModelProviderAgent, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};

export const POD_CREDENTIAL_LABELS: Record<ModelProviderPodCredential, string> = {
  "access-key": "Access key",
  "bearer-token": "API key",
  ambient: "IAM role",
  none: "Machines only",
};

export const DEFAULT_REGION = "us-west-2";

export type CredentialAction = "keep" | "replace" | "clear";

export interface ProviderForm {
  name: string;
  owner: ResourceOwner;
  agents: ModelProviderAgent[];
  region: string;
  models: Partial<Record<ModelProviderAgent, ModelProviderModel[]>>;
  localAwsProfile: string;
  podCredential: ModelProviderPodCredential;
  credentialAction: CredentialAction;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  bearerToken: string;
}

export function emptyProviderForm(isAdmin: boolean): ProviderForm {
  return {
    name: "Bedrock",
    owner: isAdmin ? "workspace" : "me",
    agents: ["claude-code"],
    region: DEFAULT_REGION,
    models: { "claude-code": bedrockDefaultModels("claude-code", DEFAULT_REGION) },
    localAwsProfile: "",
    podCredential: "access-key",
    credentialAction: "replace",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    bearerToken: "",
  };
}

export function formFromProvider(p: ModelProvider): ProviderForm {
  return {
    name: p.name,
    owner: p.ownerUserId ? "me" : "workspace",
    agents: [...p.agents],
    region: p.region,
    models: Object.fromEntries(
      Object.entries(p.models).map(([k, v]) => [
        k,
        ((v as ModelProviderModel[] | undefined) ?? []).map((m) => ({ ...m })),
      ]),
    ),
    localAwsProfile: p.localAwsProfile ?? "",
    podCredential: p.podCredential,
    credentialAction: p.hasPodCredentials ? "keep" : "replace",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    bearerToken: "",
  };
}

/** Check / uncheck an agent; a newly checked one starts from the suggested models. */
export function toggleAgent(f: ProviderForm, agent: ModelProviderAgent, on: boolean): ProviderForm {
  const agents = MODEL_PROVIDER_AGENTS.filter((a) =>
    a === agent ? on : f.agents.includes(a),
  ) as ModelProviderAgent[];
  const models = { ...f.models };
  if (on && !models[agent]?.length) models[agent] = bedrockDefaultModels(agent, f.region);
  return { ...f, agents, models };
}

const sameModels = (a: ModelProviderModel[] | undefined, b: ModelProviderModel[]) =>
  !!a && a.length === b.length && a.every((m, i) => m.id === b[i].id);

/** Change the region; model lists still on the old region's suggestions follow it. */
export function withRegion(f: ProviderForm, region: string): ProviderForm {
  const models = { ...f.models };
  for (const agent of f.agents) {
    if (sameModels(models[agent], bedrockDefaultModels(agent, f.region))) {
      models[agent] = bedrockDefaultModels(agent, region);
    }
  }
  return { ...f, region, models };
}

/** Parse the models textarea: one per line, `id` or `id | label`. */
export function parseModels(text: string): ModelProviderModel[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, ...rest] = line.split("|");
      const label = rest.join("|").trim();
      return label ? { id: id.trim(), label } : { id: id.trim() };
    })
    .filter((m) => m.id);
}

export function formatModels(models: ModelProviderModel[] | undefined): string {
  return (models ?? []).map((m) => (m.label ? `${m.id} | ${m.label}` : m.id)).join("\n");
}

/** What's wrong with the form, or null. */
export function validateProviderForm(f: ProviderForm, creating: boolean): string | null {
  if (!f.name.trim()) return "Give it a name.";
  if (f.agents.length === 0) return "Pick at least one agent.";
  if (!isValidAwsRegion(f.region.trim())) return "Region looks like us-west-2.";
  if (f.localAwsProfile.trim() && !isValidAwsProfileName(f.localAwsProfile.trim())) {
    return "That isn't a valid AWS profile name.";
  }
  const stores = f.podCredential === "access-key" || f.podCredential === "bearer-token";
  if (stores && (creating || f.credentialAction === "replace")) {
    if (f.podCredential === "access-key" && (!f.accessKeyId.trim() || !f.secretAccessKey.trim())) {
      return "Enter the access key id and secret, or pick another pod sign-in.";
    }
    if (f.podCredential === "bearer-token" && !f.bearerToken.trim()) {
      return "Enter the Bedrock API key, or pick another pod sign-in.";
    }
  }
  return null;
}

function credentialsFrom(f: ProviderForm): ModelProviderCredentials | null | undefined {
  const stores = f.podCredential === "access-key" || f.podCredential === "bearer-token";
  if (!stores || f.credentialAction === "clear") return null;
  if (f.credentialAction === "keep") return undefined;
  if (f.podCredential === "access-key") {
    return {
      type: "access-key",
      accessKeyId: f.accessKeyId.trim(),
      secretAccessKey: f.secretAccessKey.trim(),
      ...(f.sessionToken.trim() ? { sessionToken: f.sessionToken.trim() } : {}),
    };
  }
  return { type: "bearer-token", bearerToken: f.bearerToken.trim() };
}

function modelsFor(f: ProviderForm): Partial<Record<ModelProviderAgent, ModelProviderModel[]>> {
  return Object.fromEntries(f.agents.map((a) => [a, f.models[a] ?? []]));
}

export function toCreateInput(f: ProviderForm): CreateModelProviderInput {
  const credentials = credentialsFrom(f);
  return {
    name: f.name.trim(),
    owner: f.owner,
    kind: "bedrock",
    agents: f.agents,
    region: f.region.trim(),
    models: modelsFor(f),
    localAwsProfile: f.localAwsProfile.trim() || null,
    podCredential: f.podCredential,
    ...(credentials ? { credentials } : {}),
  };
}

export function toUpdateInput(f: ProviderForm, original: ModelProvider): UpdateModelProviderInput {
  const credentials = credentialsFrom(f);
  // Nothing stored and nothing to store: leave the credentials alone.
  const sendCredentials =
    credentials !== undefined && !(credentials === null && !original.hasPodCredentials);
  return {
    name: f.name.trim(),
    ...(f.owner !== (original.ownerUserId ? "me" : "workspace") ? { owner: f.owner } : {}),
    agents: f.agents,
    region: f.region.trim(),
    models: modelsFor(f),
    localAwsProfile: f.localAwsProfile.trim() || null,
    podCredential: f.podCredential,
    ...(sendCredentials ? { credentials } : {}),
  };
}

/** "Pods: access key" etc., for the list. */
export function podsLabel(p: Pick<ModelProvider, "podCredential">): string {
  return {
    "access-key": "Pods: access key",
    "bearer-token": "Pods: API key",
    ambient: "Pods: IAM role",
    none: "Machines only",
  }[p.podCredential];
}
