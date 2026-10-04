/**
 * Config as code — the manifest format (`docs/config-as-code.md`): one YAML
 * document per resource, `apiVersion: optio/v1`, a `kind`, a `metadata.name`
 * that is its identity, and a `spec` in the kind's shape. The API validates
 * them (schemas/config.ts, the same shape served as JSON Schema), the CLI
 * reads and writes them, and the apply result below is what both report.
 * Like `work/`, this lives outside `types/`: it is not a mobile model.
 */
import type { WorkReviewTrigger } from "../work/settings.js";

export const MANIFEST_API_VERSION = "optio/v1";

/** A secret reference as a connection's or an MCP server's config carries it: `${{NAME}}`. */
export const SECRET_REFERENCE = /^\$\{\{\s*([A-Za-z_][A-Za-z0-9_]{0,127})\s*\}\}$/;

export const MANIFEST_KINDS = [
  "Work",
  "Prompt",
  "Repo",
  "McpServer",
  "Skill",
  "Connection",
] as const;
export type ManifestKind = (typeof MANIFEST_KINDS)[number];

export const isManifestKind = (kind: string): kind is ManifestKind =>
  (MANIFEST_KINDS as readonly string[]).includes(kind);

/** The directory an export files each kind under, and the order kinds apply in. */
export const MANIFEST_KIND_DIRS: Record<ManifestKind, string> = {
  Repo: "repos",
  McpServer: "mcp-servers",
  Skill: "skills",
  Connection: "connections",
  Prompt: "prompts",
  Work: "work",
};

/** Kinds in the order an apply writes them: what Work refers to comes first. */
export const MANIFEST_APPLY_ORDER: readonly ManifestKind[] = [
  "Repo",
  "McpServer",
  "Skill",
  "Connection",
  "Prompt",
  "Work",
];

export interface ManifestMetadata {
  /** The identity: unique per workspace and kind. */
  name: string;
  description?: string | null;
}

interface ManifestOf<K extends ManifestKind, S> {
  apiVersion: typeof MANIFEST_API_VERSION;
  kind: K;
  metadata: ManifestMetadata;
  spec: S;
}

// ── Work ────────────────────────────────────────────────────────────────────

/** Names added to a default set, and names taken out of it. */
export interface NameOverrides {
  add?: string[];
  remove?: string[];
}

/**
 * What starts the work: one key, the trigger type, holding that trigger's
 * config in the shape the API stores. Absent = on demand.
 */
export type WorkWhenManifest =
  | { schedule: string | { cron: string } }
  | { webhook: { path: string } }
  | { ticket: { source: string; labels?: string[] } }
  | { github: Record<string, unknown> }
  | { slack: Record<string, unknown> }
  | { linear: Record<string, unknown> };

export interface WorkManifestSpec {
  when?: WorkWhenManifest;
  /** The repo it works in (pod work only; a manifest can't describe work on a machine). */
  where?: { repo?: string | null; branch?: string | null };
  who: {
    /** Agent runtime, or `shell` for a Job that runs its prompt as a command. */
    runtime: string;
    options?: Record<string, string | boolean>;
    model?: string | null;
  };
  what: {
    prompt?: string;
    /** A file next to the manifest holding the prompt; inlined before apply. */
    promptFile?: string;
    runTitle?: string | null;
  };
  /** Default `exits`. `waits-for-messages` makes a persistent agent. */
  then?: "exits" | "until-merged" | "waits-for-messages";
  mergeWhenReady?: boolean;
  retries?: number;
  priority?: number;
  /** Pod secrets, by name — never values. */
  secrets?: string[];
  /** `WorkSettings`, with connections, MCP servers and skills by name. */
  environment?: {
    connections?: NameOverrides;
    mcpServers?: NameOverrides;
    skills?: NameOverrides;
    setupCommands?: string | null;
    review?: { enabled: boolean; trigger?: WorkReviewTrigger } | null;
    cautiousMode?: boolean | null;
    maxAutoResumes?: number | null;
  };
  /** A persistent agent's identity and pod. */
  agent?: {
    slug?: string;
    systemPrompt?: string | null;
    systemPromptFile?: string;
    agentsMd?: string | null;
    agentsMdFile?: string;
    podLifecycle?: "always-on" | "sticky" | "on-demand";
  };
  /** JSON Schema of the `{{param}}`s triggered work takes. */
  params?: Record<string, unknown> | null;
  limits?: { maxTurns?: number | null; budgetUsd?: string | number | null };
  pods?: { maxPodInstances?: number; maxAgentsPerPod?: number };
  enabled?: boolean;
}

// ── Prompt ──────────────────────────────────────────────────────────────────

export interface PromptManifestSpec {
  kind?: "prompt" | "review" | "job" | "task";
  template?: string;
  templateFile?: string;
  params?: Record<string, unknown> | null;
  defaultAgentType?: string | null;
}

// ── Repo ────────────────────────────────────────────────────────────────────

/**
 * The repo's URL (its identity) plus any of the settings `PATCH /api/repos/:id`
 * takes (the Slack webhook, a credential, excepted). Only the settings the
 * manifest names are managed; the rest keep their values.
 */
export interface RepoManifestSpec {
  url: string;
  defaultBranch?: string;
  [setting: string]: unknown;
}

// ── McpServer ───────────────────────────────────────────────────────────────

export interface McpServerManifestSpec {
  command: string;
  args?: string[];
  /** Values may be `${{SECRET_NAME}}` references. */
  env?: Record<string, string>;
  installCommand?: string | null;
  /** A repo URL scopes the server to that repo; absent = the whole workspace. */
  repo?: string | null;
  enabled?: boolean;
}

// ── Skill ───────────────────────────────────────────────────────────────────

export interface SkillManifestSpec {
  /** A custom skill: the SKILL.md body (or the command file, layout `commands`). */
  prompt?: string;
  promptFile?: string;
  layout?: "commands" | "skill-dir";
  /** Extra files of a `skill-dir` skill, path → content. */
  files?: Record<string, string>;
  /** A directory next to the manifest: SKILL.md is the prompt, the rest the files. */
  filesFrom?: string;
  /** A marketplace skill instead: cloned from a git source. */
  source?: { url: string; ref?: string; path?: string };
  agentTypes?: string[];
  repo?: string | null;
  enabled?: boolean;
}

// ── Connection ──────────────────────────────────────────────────────────────

export interface ConnectionManifestSpec {
  /** The provider's slug (`github`, `slack`, `notion`, …). */
  provider: string;
  /** Provider config; secret fields must be `${{SECRET_NAME}}` references. */
  config?: Record<string, unknown>;
  repo?: string | null;
  enabled?: boolean;
  assignments?: Array<{
    /** A repo URL, or absent for every repo. */
    repo?: string | null;
    agentTypes?: string[];
    permission?: "read" | "write" | "full";
  }>;
}

export type WorkManifest = ManifestOf<"Work", WorkManifestSpec>;
export type PromptManifest = ManifestOf<"Prompt", PromptManifestSpec>;
export type RepoManifest = ManifestOf<"Repo", RepoManifestSpec>;
export type McpServerManifest = ManifestOf<"McpServer", McpServerManifestSpec>;
export type SkillManifest = ManifestOf<"Skill", SkillManifestSpec>;
export type ConnectionManifest = ManifestOf<"Connection", ConnectionManifestSpec>;

export type Manifest =
  | WorkManifest
  | PromptManifest
  | RepoManifest
  | McpServerManifest
  | SkillManifest
  | ConnectionManifest;

// ── Applying ────────────────────────────────────────────────────────────────

/** One document as it reached the apply: where it came from and what it said. */
export interface ManifestInput {
  /** The file, relative to the directory applied (what errors and `managedBy` name). */
  path: string;
  /** The parsed document, `*File` fields already inlined. */
  document: unknown;
}

export const CONFIG_ACTIONS = [
  "create",
  "update",
  "unchanged",
  "adopt",
  "replace",
  "prune",
  "error",
] as const;
export type ConfigAction = (typeof CONFIG_ACTIONS)[number];

export interface ConfigPlanItem {
  kind: string;
  name: string;
  path: string;
  action: ConfigAction;
  /** The resource it is or would be (absent for a new one in a dry run, and for errors). */
  resourceId?: string | null;
  /** `update`: the fields that differ; `reverted` says they were changed in the UI, not the file. */
  changes?: string[];
  reverted?: boolean;
  /** `error`: what is wrong; `replace`: why the row had to be recreated. */
  message?: string;
}

export interface ConfigApplySummary {
  created: number;
  updated: number;
  /** Updates that put back a UI edit (counted in `updated` too). */
  reverted: number;
  unchanged: number;
  adopted: number;
  replaced: number;
  pruned: number;
  errors: number;
}

export interface ConfigApplyResult {
  dryRun: boolean;
  /** The source applied, when one was (a CLI apply has none). */
  source?: { id: string; name: string } | null;
  items: ConfigPlanItem[];
  summary: ConfigApplySummary;
  /** When the apply ran (ISO-8601). */
  at: string;
}

export const CONFIG_SOURCE_KINDS = ["dir"] as const;
export type ConfigSourceKind = (typeof CONFIG_SOURCE_KINDS)[number];

/** The configuration directory as Settings shows it. */
export interface ConfigSourceView {
  id: string;
  name: string;
  kind: ConfigSourceKind;
  /** The directory in the API pod. */
  path: string;
  workspaceId: string | null;
  prune: boolean;
  enabled: boolean;
  /** `env`: declared by the deployment (read-only in Settings). */
  origin: "env" | "settings";
  intervalMs: number;
  lastSyncAt: string | null;
  /** A short hash of the directory's contents at the last sync. */
  lastSyncHash: string | null;
  lastSyncError: string | null;
  lastSync: ConfigApplyResult | null;
}

/** `GET /api/config/status`. */
export interface ConfigStatus {
  /** `OPTIO_CONFIG_DIR` is set and points at this workspace. */
  enabled: boolean;
  source: ConfigSourceView | null;
  /** Where the JSON Schema of a manifest is served. */
  schemaUrl: string;
}

/** `GET /api/config/export`: one exported resource. */
export interface ExportedManifest {
  kind: ManifestKind;
  name: string;
  /** Where an export files it: `work/nightly-bump.yaml`. */
  path: string;
  document: Manifest;
}
