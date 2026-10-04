/**
 * Zod schemas for config as code (docs/config-as-code.md): the manifest
 * format `POST /api/config/apply` and the configuration directory accept, and
 * the apply result they answer with. `manifestJsonSchema()` serves the same
 * shape as JSON Schema (`GET /api/config/schema.json`) for editors and CI.
 */
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AGENT_TYPES,
  CONFIG_ACTIONS,
  MANIFEST_API_VERSION,
  MANIFEST_KINDS,
  SHELL_RUNTIME,
  type ConfigApplyResult,
  type ConnectionManifest,
  type Manifest,
  type McpServerManifest,
  type PromptManifest,
  type SkillManifest,
  type WorkManifest,
} from "@optio/shared";
import { ErrorResponseSchema } from "./common.js";

const name = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .describe("The identity: unique per workspace and kind");

const MetadataSchema = z
  .object({
    name,
    description: z.string().max(2000).nullable().optional(),
  })
  .describe("Who the resource is");

const base = <K extends string>(kind: K) => ({
  apiVersion: z.literal(MANIFEST_API_VERSION),
  kind: z.literal(kind),
  metadata: MetadataSchema,
});

const secretName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/, "a secret name: letters, digits and underscores");

const repoUrl = z.string().url().describe("A repo URL, the way Repos lists it");

const NameOverridesSchema = z
  .object({
    add: z.array(z.string().min(1)).max(200).optional(),
    remove: z.array(z.string().min(1)).max(200).optional(),
  })
  .strict()
  .describe("Names added to the default set, and names taken out of it");

// ── Work ────────────────────────────────────────────────────────────────────

const WhenSchema = z
  .union([
    z
      .object({
        schedule: z.union([
          z.string().min(1).describe("A cron expression"),
          z.object({ cron: z.string().min(1) }).strict(),
        ]),
      })
      .strict(),
    z.object({ webhook: z.object({ path: z.string().min(1) }).strict() }).strict(),
    z
      .object({
        ticket: z.object({ source: z.string().min(1), labels: z.array(z.string()).optional() }),
      })
      .strict(),
    z.object({ github: z.record(z.unknown()) }).strict(),
    z.object({ slack: z.record(z.unknown()) }).strict(),
    z.object({ linear: z.record(z.unknown()) }).strict(),
  ])
  .describe(
    "What starts it: one key — the trigger type — holding that trigger's config. Absent = on demand.",
  );

const WorkSpecSchema = z
  .object({
    when: WhenSchema.optional(),
    where: z
      .object({
        repo: repoUrl.nullable().optional(),
        branch: z
          .string()
          .regex(/^[a-zA-Z0-9._/-]+$/, "Invalid branch name")
          .nullable()
          .optional(),
      })
      .strict()
      .optional()
      .describe("The repo it works in (pod work only)"),
    who: z
      .object({
        runtime: z
          .enum([...AGENT_TYPES, SHELL_RUNTIME] as unknown as [string, ...string[]])
          .describe("Agent runtime, or `shell` for a Job that runs its prompt as a command"),
        options: z.record(z.union([z.string(), z.boolean()])).optional(),
        model: z.string().max(200).nullable().optional(),
      })
      .strict(),
    what: z
      .object({
        prompt: z.string().max(100_000).optional(),
        promptFile: z.string().min(1).optional().describe("A file next to the manifest"),
        runTitle: z.string().max(200).nullable().optional(),
      })
      .strict(),
    then: z.enum(["exits", "until-merged", "waits-for-messages"]).optional(),
    mergeWhenReady: z.boolean().optional(),
    retries: z.number().int().min(0).max(10).optional(),
    priority: z.number().int().min(1).max(1000).optional(),
    secrets: z.array(secretName).max(100).optional().describe("Pod secrets, by name"),
    environment: z
      .object({
        connections: NameOverridesSchema.optional(),
        mcpServers: NameOverridesSchema.optional(),
        skills: NameOverridesSchema.optional(),
        setupCommands: z.string().max(20_000).nullable().optional(),
        review: z
          .object({ enabled: z.boolean(), trigger: z.enum(["on_pr", "on_ci_pass"]).optional() })
          .strict()
          .nullable()
          .optional(),
        cautiousMode: z.boolean().nullable().optional(),
        maxAutoResumes: z.number().int().min(0).max(100).nullable().optional(),
      })
      .strict()
      .optional(),
    agent: z
      .object({
        slug: z
          .string()
          .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and hyphens only")
          .optional(),
        systemPrompt: z.string().nullable().optional(),
        systemPromptFile: z.string().min(1).optional(),
        agentsMd: z.string().nullable().optional(),
        agentsMdFile: z.string().min(1).optional(),
        podLifecycle: z.enum(["always-on", "sticky", "on-demand"]).optional(),
      })
      .strict()
      .optional(),
    params: z.record(z.unknown()).nullable().optional(),
    limits: z
      .object({
        maxTurns: z.number().int().min(1).max(10_000).nullable().optional(),
        budgetUsd: z.union([z.string(), z.number()]).nullable().optional(),
      })
      .strict()
      .optional(),
    pods: z
      .object({
        maxPodInstances: z.number().int().min(1).max(20).optional(),
        maxAgentsPerPod: z.number().int().min(1).max(50).optional(),
      })
      .strict()
      .optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine((s) => s.what.prompt !== undefined || s.what.promptFile !== undefined, {
    message: "what.prompt or what.promptFile is required",
    path: ["what"],
  });

export const WorkManifestSchema = z.object({ ...base("Work"), spec: WorkSpecSchema }).strict();

// ── Prompt ──────────────────────────────────────────────────────────────────

const PromptSpecSchema = z
  .object({
    kind: z.enum(["prompt", "review", "job", "task"]).optional(),
    template: z.string().min(1).optional(),
    templateFile: z.string().min(1).optional(),
    params: z.record(z.unknown()).nullable().optional(),
    defaultAgentType: z.string().nullable().optional(),
  })
  .strict()
  .refine((s) => s.template !== undefined || s.templateFile !== undefined, {
    message: "template or templateFile is required",
  });

export const PromptManifestSchema = z
  .object({ ...base("Prompt"), spec: PromptSpecSchema })
  .strict();

// ── Repo ────────────────────────────────────────────────────────────────────

/**
 * The settings a Repo manifest may name — what `PATCH /api/repos/:id` takes,
 * minus the Slack webhook (a credential). Only the named ones are managed.
 */
export const RepoSettingsSchema = z
  .object({
    defaultBranch: z.string().optional(),
    imagePreset: z.string().optional(),
    extraPackages: z.string().optional(),
    setupCommands: z.string().optional(),
    customDockerfile: z.string().nullable().optional(),
    autoMerge: z.boolean().optional(),
    cautiousMode: z.boolean().optional(),
    defaultAgentType: z.enum([...AGENT_TYPES] as [string, ...string[]]).optional(),
    promptTemplateOverride: z.string().nullable().optional(),
    claudeModel: z.string().optional(),
    claudeContextWindow: z.string().optional(),
    claudeEffort: z.string().optional(),
    copilotModel: z.string().optional(),
    copilotEffort: z.string().optional(),
    opencodeModel: z.string().optional(),
    opencodeAgent: z.string().optional(),
    opencodeProvider: z.string().optional(),
    opencodeBaseUrl: z.string().url().nullable().optional(),
    geminiModel: z.string().optional(),
    geminiApprovalMode: z.string().optional(),
    openclawModel: z.string().nullable().optional(),
    openclawAgent: z.string().nullable().optional(),
    cursorModel: z.string().nullable().optional(),
    maxTurnsCoding: z.number().int().min(1).max(10000).optional(),
    maxTurnsReview: z.number().int().min(1).max(10000).optional(),
    autoResume: z.boolean().optional(),
    planningModeEnabled: z.boolean().optional(),
    maxConcurrentTasks: z.number().int().min(1).max(50).optional(),
    maxPodInstances: z.number().int().min(1).max(20).optional(),
    maxAgentsPerPod: z.number().int().min(1).max(50).optional(),
    reviewEnabled: z.boolean().optional(),
    reviewTrigger: z.enum(["manual", "on_pr", "on_ci_pass"]).optional(),
    reviewPromptTemplate: z.string().nullable().optional(),
    testCommand: z.string().optional(),
    reviewAgentType: z
      .enum([...AGENT_TYPES] as [string, ...string[]])
      .nullable()
      .optional(),
    reviewModel: z.string().nullable().optional(),
    externalReviewMode: z.enum(["off", "on_request", "on_pr_hold", "on_pr_post"]).optional(),
    externalReviewFilters: z
      .object({
        skipDrafts: z.boolean().optional(),
        skipOptioAuthored: z.boolean().optional(),
        includeAuthors: z.array(z.string()).optional(),
        excludeAuthors: z.array(z.string()).optional(),
        includeLabels: z.array(z.string()).optional(),
        excludeLabels: z.array(z.string()).optional(),
      })
      .nullable()
      .optional(),
    externalReviewWaitForCi: z.boolean().optional(),
    maxAutoResumes: z.number().int().min(1).max(100).nullable().optional(),
    slackChannel: z.string().nullable().optional(),
    slackNotifyOn: z
      .array(z.enum(["completed", "failed", "needs_attention", "pr_opened"]))
      .optional(),
    slackEnabled: z.boolean().optional(),
    networkPolicy: z.enum(["unrestricted", "restricted"]).optional(),
    secretProxy: z.boolean().optional(),
    offPeakOnly: z.boolean().optional(),
    cpuRequest: z.string().nullable().optional(),
    cpuLimit: z.string().nullable().optional(),
    memoryRequest: z.string().nullable().optional(),
    memoryLimit: z.string().nullable().optional(),
    dockerInDocker: z.boolean().optional(),
  })
  .strict();

export const REPO_SETTING_KEYS = Object.keys(RepoSettingsSchema.shape) as Array<
  keyof z.infer<typeof RepoSettingsSchema>
>;

const RepoSpecSchema = RepoSettingsSchema.extend({ url: repoUrl }).strict();

export const RepoManifestSchema = z.object({ ...base("Repo"), spec: RepoSpecSchema }).strict();

// ── McpServer ───────────────────────────────────────────────────────────────

const McpServerSpecSchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
    env: z.record(z.string()).optional().describe("Values may be `${{SECRET_NAME}}` references"),
    installCommand: z.string().nullable().optional(),
    repo: repoUrl.nullable().optional().describe("Scope it to one repo; absent = the workspace"),
    enabled: z.boolean().optional(),
  })
  .strict();

export const McpServerManifestSchema = z
  .object({ ...base("McpServer"), spec: McpServerSpecSchema })
  .strict();

// ── Skill ───────────────────────────────────────────────────────────────────

const SkillSpecSchema = z
  .object({
    prompt: z.string().min(1).optional(),
    promptFile: z.string().min(1).optional(),
    layout: z.enum(["commands", "skill-dir"]).optional(),
    files: z
      .record(z.string())
      .optional()
      .describe("Extra files of a skill-dir skill, path → content"),
    filesFrom: z.string().min(1).optional().describe("A directory next to the manifest"),
    source: z
      .object({
        url: z.string().min(1),
        ref: z.string().optional(),
        path: z.string().optional(),
      })
      .strict()
      .optional()
      .describe("A marketplace skill, cloned from a git source"),
    agentTypes: z.array(z.string()).optional(),
    repo: repoUrl.nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (s) => {
      const custom =
        s.prompt !== undefined || s.promptFile !== undefined || s.filesFrom !== undefined;
      return custom !== (s.source !== undefined);
    },
    { message: "a skill has either a prompt (prompt, promptFile or filesFrom) or a source" },
  );

export const SkillManifestSchema = z.object({ ...base("Skill"), spec: SkillSpecSchema }).strict();

// ── Connection ──────────────────────────────────────────────────────────────

const ConnectionSpecSchema = z
  .object({
    provider: z.string().min(1).describe("The provider's slug"),
    config: z.record(z.unknown()).optional(),
    repo: repoUrl.nullable().optional(),
    enabled: z.boolean().optional(),
    assignments: z
      .array(
        z
          .object({
            repo: repoUrl.nullable().optional().describe("Absent = every repo"),
            agentTypes: z.array(z.string()).optional(),
            permission: z.enum(["read", "write", "full"]).optional(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
  })
  .strict();

export const ConnectionManifestSchema = z
  .object({ ...base("Connection"), spec: ConnectionSpecSchema })
  .strict();

// ── Any manifest ────────────────────────────────────────────────────────────

export const ManifestSchema = z
  .discriminatedUnion("kind", [
    WorkManifestSchema,
    PromptManifestSchema,
    RepoManifestSchema,
    McpServerManifestSchema,
    SkillManifestSchema,
    ConnectionManifestSchema,
  ])
  .describe("One Optio resource as configuration");

export const ManifestKindSchema = z.enum(MANIFEST_KINDS);

/** The JSON Schema of a manifest, for `# yaml-language-server: $schema=` and CI. */
export function manifestJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://optio.dev/schemas/manifest.json",
    title: "Optio manifest",
    ...zodToJsonSchema(ManifestSchema, { $refStrategy: "none", target: "jsonSchema7" }),
  };
}

// ── Applying ────────────────────────────────────────────────────────────────

export const ManifestInputSchema = z
  .object({
    path: z.string().min(1).max(1000).describe("The file, relative to the directory applied"),
    document: z.unknown().describe("The parsed document, `*File` fields already inlined"),
  })
  .describe("One document as the CLI read it");

export const ApplyBodySchema = z
  .object({
    manifests: z.array(ManifestInputSchema).max(1000),
    dryRun: z.boolean().optional().describe("Plan only; write nothing"),
  })
  .describe("Manifests to apply to the current workspace");

export const ConfigPlanItemSchema = z.object({
  kind: z.string(),
  name: z.string(),
  path: z.string(),
  action: z.enum(CONFIG_ACTIONS),
  resourceId: z.string().nullable().optional(),
  changes: z.array(z.string()).optional(),
  reverted: z.boolean().optional(),
  message: z.string().optional(),
});

export const ConfigApplySummarySchema = z.object({
  created: z.number(),
  updated: z.number(),
  reverted: z.number(),
  unchanged: z.number(),
  adopted: z.number(),
  replaced: z.number(),
  pruned: z.number(),
  errors: z.number(),
});

export const ConfigApplyResultSchema = z
  .object({
    dryRun: z.boolean(),
    source: z.object({ id: z.string(), name: z.string() }).nullable().optional(),
    items: z.array(ConfigPlanItemSchema),
    summary: ConfigApplySummarySchema,
    at: z.string(),
  })
  .describe("What an apply did, or (dry run) would do, per manifest");

export const ConfigSourceViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["dir"]),
  path: z.string(),
  workspaceId: z.string().nullable(),
  prune: z.boolean(),
  enabled: z.boolean(),
  origin: z.enum(["env", "settings"]),
  intervalMs: z.number(),
  lastSyncAt: z.string().nullable(),
  lastSyncHash: z.string().nullable(),
  lastSyncError: z.string().nullable(),
  lastSync: ConfigApplyResultSchema.nullable(),
});

export const ConfigStatusSchema = z
  .object({
    enabled: z.boolean(),
    source: ConfigSourceViewSchema.nullable(),
    schemaUrl: z.string(),
  })
  .describe("Whether a configuration directory feeds this workspace, and how its last sync went");

export const SyncQuerySchema = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .describe("`true` plans the directory without writing anything"),
});

export const ExportQuerySchema = z.object({
  kind: z
    .string()
    .optional()
    .describe("Comma-separated manifest kinds (Work, Prompt, …); default every kind"),
  id: z.string().optional().describe("One resource's id (with `kind`)"),
});

export const ExportedManifestSchema = z.object({
  kind: ManifestKindSchema,
  name: z.string(),
  path: z.string(),
  document: z.unknown(),
});

export const ExportResponseSchema = z
  .object({ manifests: z.array(ExportedManifestSchema) })
  .describe("The organization's resources as manifests");

export const ConfigErrorSchema = ErrorResponseSchema;

/** `managedBy` on a row a configuration directory manages (shared `ManagedBy`). */
export const ManagedBySchema = z
  .object({
    objectId: z.string(),
    sourceId: z.string(),
    sourceName: z.string(),
    path: z.string().describe("The manifest's file, relative to the directory"),
    kind: z.string().describe("The manifest kind"),
  })
  .describe("Set when a configuration directory manages the row: the file is the truth");

// The schemas accept the shared manifest types — fail the build if they drift.
const _work: WorkManifest = {} as z.infer<typeof WorkManifestSchema>;
const _prompt: PromptManifest = {} as z.infer<typeof PromptManifestSchema>;
const _mcp: McpServerManifest = {} as z.infer<typeof McpServerManifestSchema>;
const _skill: SkillManifest = {} as z.infer<typeof SkillManifestSchema>;
const _connection: ConnectionManifest = {} as z.infer<typeof ConnectionManifestSchema>;
const _any: Manifest = {} as z.infer<typeof ManifestSchema>;
const _result: ConfigApplyResult = {} as z.infer<typeof ConfigApplyResultSchema>;
void _work;
void _prompt;
void _mcp;
void _skill;
void _connection;
void _any;
void _result;
