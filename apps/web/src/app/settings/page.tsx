"use client";

import { useState, useEffect, type ReactNode } from "react";
import { SettingsLayout } from "@/components/settings/settings-layout";
import { usePageTitle } from "@/hooks/use-page-title";
import { api, type VisibleSecret } from "@/lib/api-client";
import { NumberInput } from "@/components/number-input";
import { toast } from "sonner";
import {
  Loader2,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Server,
  Sparkles,
  Plus,
  X,
  AlertTriangle,
  Trash2,
  Ticket,
  KeyRound,
  Settings as SettingsIcon,
  Store,
} from "lucide-react";
import {
  OPTIO_TOOL_CATEGORIES,
  ALL_OPTIO_TOOL_NAMES,
  DEFAULT_OPTIO_AGENT_MODEL,
  type AgentType,
} from "@optio/shared";
import { NotificationPreferences } from "@/components/notifications/notification-preferences";
import { ApiKeysManager } from "@/components/settings/api-keys-manager";
import { ModelProvidersManager } from "@/components/settings/model-providers-manager";
import { SignInSettings } from "@/components/settings/sign-in-settings";
import { ReviewAgentPicker } from "@/components/review-agent-picker";
import { AgentIcon, BrandIcon, brandFor } from "@/components/brand-icon";
import { AgentOptionsPicker } from "@/components/agent-options-picker";
import { PageHeader } from "@/components/page-header";
import { EmptyState } from "@/components/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Segmented } from "@/components/ui/segmented";
import { Disclosure } from "@/components/ui/disclosure";
import { OwnerPicker } from "@/components/ui/owner-picker";
import { OwnerChip } from "@/components/ui/owner-chip";
import { ManagedChip } from "@/components/ui/managed-chip";
import { ConfigAsCodeSettings } from "@/components/settings/config-as-code";
import type { ManagedBy } from "@optio/shared";
import { useCurrentUser } from "@/hooks/use-current-user";
import { OWNER_SCOPE_LABEL, ownerOf, ownerScope, type Owned, type OwnerScope } from "@/lib/owner";
import {
  BTN_HEADER,
  BTN_PRIMARY,
  BTN_ROW,
  BTN_ROW_DANGER,
  BTN_SECONDARY,
  BTN_TEXT,
  CardFooter,
  Field,
  INPUT,
  InsetForm,
  MONO_AREA,
  SkeletonCard,
  Tag,
  TemplateVars,
} from "@/components/settings/settings-ui";
import { inputClass } from "@/components/ui/input";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function PromptTemplateEditor() {
  const [template, setTemplate] = useState("");
  const [autoMerge, setAutoMerge] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api
      .getEffectiveTemplate()
      .then((res) => {
        setTemplate(res.template);
        setAutoMerge(res.autoMerge);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.savePromptTemplate({ template, autoMerge });
      toast.success("Prompt template saved");
    } catch {
      toast.error("Failed to save");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    const res = await api.getBuiltinDefault();
    setTemplate(res.template);
  };

  const label = "Agent prompt";
  const hint = "Default for every repo unless a repo overrides it";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={2} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={autoMerge ? "auto-merge on" : "auto-merge off"}
      bodyClassName="p-4 space-y-4"
    >
      <TemplateVars
        vars={[
          ["TASK_FILE", "Path to the task markdown file written into the worktree"],
          ["BRANCH_NAME", "Git branch name the agent is working on"],
          ["TASK_ID", "Unique task identifier"],
          ["TASK_TITLE", "Short title of the task"],
          ["REPO_NAME", "Repository name (e.g. owner/repo)"],
          [
            "AUTO_MERGE",
            <>
              Whether auto-merge is enabled — use with{" "}
              <code className="text-primary">{"{{#if AUTO_MERGE}}...{{/if}}"}</code>
            </>,
          ],
        ]}
      />
      <textarea
        value={template}
        onChange={(e) => setTemplate(e.target.value)}
        rows={12}
        className={MONO_AREA}
      />
      <label className="flex items-center gap-2 text-sm cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={autoMerge}
          onChange={(e) => setAutoMerge(e.target.checked)}
          className="w-4 h-4 rounded"
        />
        Auto-merge PRs
      </label>
      <CardFooter
        note={
          <button onClick={handleReset} className="text-xs text-primary hover:underline">
            Reset to default
          </button>
        }
      >
        <button onClick={handleSave} disabled={saving} className={BTN_PRIMARY}>
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}

function DefaultReviewEditor() {
  const [reviewPrompt, setReviewPrompt] = useState("");
  // Workspace-level review defaults — saved via PUT /api/optio/settings.
  const [reviewAgentType, setReviewAgentType] = useState<AgentType>("claude-code");
  const [reviewModel, setReviewModel] = useState("");
  const [reviewTrigger, setReviewTrigger] = useState("on_ci_pass");
  const [reviewContextWindow, setReviewContextWindow] = useState("200k");
  const [reviewEffort, setReviewEffort] = useState("medium");
  const [reviewThinking, setReviewThinking] = useState(true);
  const [reviewTestCommand, setReviewTestCommand] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      api.getReviewDefault().catch(() => null),
      api.getOptioSettings().catch(() => null),
    ])
      .then(([promptRes, settingsRes]) => {
        if (promptRes?.template) {
          setReviewPrompt(promptRes.template);
        } else {
          import("@optio/shared")
            .then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
            .catch(() => {});
        }
        const s = settingsRes?.settings;
        if (s) {
          if (s.defaultReviewAgentType) setReviewAgentType(s.defaultReviewAgentType as AgentType);
          if (s.defaultReviewModel) setReviewModel(s.defaultReviewModel);
        }
      })
      .finally(() => setLoading(false));
  }, []);

  const label = "Code review";
  const hint = "The default reviewer for every repo";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={3} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={[reviewAgentType, reviewModel, reviewEffort].filter(Boolean).join(" · ")}
      summaryIcon={<AgentIcon runtime={reviewAgentType} className="w-3 h-3" />}
      bodyClassName="p-4 space-y-4"
    >
      <Field label="Starts">
        <Segmented
          value={reviewTrigger}
          onChange={setReviewTrigger}
          aria-label="Default trigger"
          options={[
            { value: "on_ci_pass", label: "After CI passes" },
            { value: "on_pr", label: "When the PR opens" },
            { value: "manual", label: "Manual only" },
          ]}
        />
      </Field>

      <ReviewAgentPicker
        agentType={reviewAgentType}
        onAgentTypeChange={(next) => setReviewAgentType(next ?? "claude-code")}
        model={reviewModel}
        onModelChange={setReviewModel}
        allowInherit={false}
      />

      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <Field label="Context window">
          <Segmented
            value={reviewContextWindow}
            onChange={setReviewContextWindow}
            aria-label="Context window"
            options={[
              { value: "200k", label: "200K" },
              { value: "1m", label: "1M" },
            ]}
          />
        </Field>
        <Field label="Effort">
          <Segmented
            value={reviewEffort}
            onChange={setReviewEffort}
            aria-label="Effort level"
            options={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        </Field>
        <label className="flex items-center gap-2 cursor-pointer pb-2">
          <input
            type="checkbox"
            checked={reviewThinking}
            onChange={(e) => setReviewThinking(e.target.checked)}
            className="w-4 h-4 rounded"
          />
          <span className="text-sm">Thinking</span>
        </label>
      </div>

      <Field
        label="Test command"
        help="Leave empty if GitHub Actions runs the tests — the reviewer checks CI status instead."
      >
        <input
          value={reviewTestCommand}
          onChange={(e) => setReviewTestCommand(e.target.value)}
          placeholder="npm test, cargo test, pytest"
          className={INPUT}
        />
      </Field>

      <div className="pt-4 border-t border-border space-y-3">
        <div className="text-xs font-medium text-text-muted">Review prompt</div>
        <TemplateVars
          vars={[
            ["PR_NUMBER", "Pull request number"],
            ["TASK_FILE", "Path to the review context file"],
            ["REPO_NAME", "Repository name (e.g. owner/repo)"],
            ["TASK_TITLE", "Original task title"],
            ["TEST_COMMAND", "Test command from repo settings"],
          ]}
        />
        <textarea
          value={reviewPrompt}
          onChange={(e) => setReviewPrompt(e.target.value)}
          rows={10}
          className={MONO_AREA}
        />
      </div>

      <CardFooter
        note={
          <button
            onClick={() =>
              import("@optio/shared").then((m) => setReviewPrompt(m.DEFAULT_REVIEW_PROMPT_TEMPLATE))
            }
            className="text-xs text-primary hover:underline"
          >
            Reset to default
          </button>
        }
      >
        <button
          onClick={async () => {
            setSaving(true);
            try {
              await api.saveReviewDefault(reviewPrompt);
              await api.updateOptioSettings({
                defaultReviewAgentType: reviewAgentType,
                defaultReviewModel: reviewModel || null,
              });
              toast.success("Review defaults saved");
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to save");
            } finally {
              setSaving(false);
            }
          }}
          disabled={saving}
          className={BTN_PRIMARY}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}

/** One row of an installable list (MCP server, skill). */
function ListRow({
  title,
  tags,
  detail,
  actions,
}: {
  title: ReactNode;
  tags?: ReactNode;
  detail?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium">{title}</span>
          {tags}
        </div>
        {detail && <p className="text-xs text-text-muted mt-0.5 truncate">{detail}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">{actions}</div>
    </li>
  );
}

const LIST = "divide-y divide-border/60 rounded-lg border border-border bg-bg";

type PickedScope = "organization" | "private";
const SCOPE_ORDER: OwnerScope[] = ["organization", "private", "others"];

/**
 * A card's rows grouped by scope. When the rows mix scopes, each scope gets a
 * small uppercase sub-header (Organization / Private / Other people's); when
 * they all share one, a single flat list whose private rows carry the chip.
 */
function ScopedRows<T extends Owned & { id: string }>({
  rows,
  viewerId,
  render,
}: {
  rows: T[];
  viewerId: string | null;
  /** `scope` is null in a flat list, where the row says its own scope. */
  render: (row: T, scope: OwnerScope | null) => ReactNode;
}) {
  const by: Record<OwnerScope, T[]> = { organization: [], private: [], others: [] };
  for (const r of rows) by[ownerScope(r, viewerId)].push(r);
  const scopes = SCOPE_ORDER.filter((scope) => by[scope].length > 0);
  if (scopes.length <= 1) return <ul className={LIST}>{rows.map((r) => render(r, null))}</ul>;
  return (
    <div className="space-y-3">
      {scopes.map((scope) => (
        <div key={scope}>
          <h3 className="text-[10px] font-semibold uppercase tracking-wider text-text-muted mb-1.5">
            {OWNER_SCOPE_LABEL[scope]}
          </h3>
          <ul className={LIST}>{by[scope].map((r) => render(r, scope))}</ul>
        </div>
      ))}
    </div>
  );
}

/** A row's scope tag: the chip in a flat list; the owner's name under Other people's. */
function ScopeTags({
  row,
  scope,
  viewerId,
}: {
  row: Owned & { managedBy?: ManagedBy | null };
  scope: OwnerScope | null;
  viewerId: string | null;
}) {
  const managed = <ManagedChip managedBy={row.managedBy} />;
  if (scope === null)
    return (
      <>
        <OwnerChip row={row} viewerId={viewerId} />
        {managed}
      </>
    );
  if (scope === "others")
    return (
      <>
        <Tag>{row.ownerName ?? "someone"}</Tag>
        {managed}
      </>
    );
  return managed;
}

function GlobalMcpServers() {
  const { userId, isAdmin, loaded } = useCurrentUser();
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [installCmd, setInstallCmd] = useState("");
  const [scope, setScope] = useState<PickedScope>("organization");

  useEffect(() => {
    api
      .listMcpServers("global")
      .then((res) => setServers(res.servers))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const label = "MCP servers";
  const hint = "Available to every repo — the organization's, or private to you";
  if (loading || !loaded) return <SkeletonCard label={label} hint={hint} rows={1} />;

  const reset = () => {
    setShowAdd(false);
    setName("");
    setCommand("");
    setArgs("");
    setEnv("");
    setInstallCmd("");
  };

  // Opens on what the viewer may make: an organization server needs an admin.
  const openAdd = () => {
    setScope(isAdmin ? "organization" : "private");
    setShowAdd(true);
  };

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={servers.length ? plural(servers.length, "server") : undefined}
      actions={
        !showAdd && (
          <button onClick={openAdd} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Use <code className="text-primary">{"${{SECRET_NAME}}"}</code> to reference Optio secrets.
      </p>

      {servers.length > 0 && (
        <ScopedRows
          rows={servers}
          viewerId={userId}
          render={(server: any, rowScope) => {
            const own = ownerScope(server, userId);
            // The organization's servers are an admin's to change; a private one its owner's.
            const canEdit = own === "private" || (own === "organization" && isAdmin);
            const canDelete = canEdit || (own === "others" && isAdmin);
            return (
              <ListRow
                key={server.id}
                title={server.name}
                tags={
                  <>
                    <ScopeTags row={server} scope={rowScope} viewerId={userId} />
                    {!server.enabled && <Tag tone="warning">disabled</Tag>}
                  </>
                }
                detail={
                  <span className="font-mono">
                    {server.command} {(server.args ?? []).join(" ")}
                  </span>
                }
                actions={
                  <>
                    {canEdit && (
                      <button
                        onClick={async () => {
                          await api.updateMcpServer(server.id, { enabled: !server.enabled });
                          setServers((prev) =>
                            prev.map((s) =>
                              s.id === server.id ? { ...s, enabled: !s.enabled } : s,
                            ),
                          );
                        }}
                        className={BTN_ROW}
                      >
                        {server.enabled ? "Disable" : "Enable"}
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={async () => {
                          await api.deleteMcpServer(server.id);
                          setServers((prev) => prev.filter((s) => s.id !== server.id));
                          toast.success("MCP server removed");
                        }}
                        className={BTN_ROW_DANGER}
                        aria-label={`Remove ${server.name}`}
                        title={
                          own === "others"
                            ? `Remove ${server.ownerName ?? "their"}'s private server`
                            : undefined
                        }
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                }
              />
            );
          }}
        />
      )}

      {servers.length === 0 && !showAdd && (
        <EmptyState
          size="panel"
          icon={Server}
          title="No MCP servers"
          description="Add one to give every agent the same tools."
          action={
            <button onClick={openAdd} className={BTN_PRIMARY}>
              <Plus className="w-3.5 h-3.5" />
              Add server
            </button>
          }
        />
      )}

      {showAdd && (
        <InsetForm>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="postgres"
                className={INPUT}
              />
            </Field>
            <Field label="Command">
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="npx"
                className={INPUT}
              />
            </Field>
          </div>
          <Field label="Args (one per line)">
            <textarea
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              rows={2}
              placeholder={"-y\n@modelcontextprotocol/server-postgres"}
              className={MONO_AREA}
            />
          </Field>
          <Field label="Env vars (KEY=VALUE, one per line)">
            <textarea
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              rows={2}
              placeholder={"POSTGRES_URL=${{POSTGRES_URL}}"}
              className={MONO_AREA}
            />
          </Field>
          <Field label="Install command (optional)">
            <input
              value={installCmd}
              onChange={(e) => setInstallCmd(e.target.value)}
              placeholder="npm install -g @modelcontextprotocol/server-postgres"
              className={INPUT}
            />
          </Field>
          <OwnerPicker what="MCP server" value={scope} onChange={setScope} canOrg={isAdmin} />
          <div className="flex justify-end items-center gap-3">
            <button onClick={reset} className={BTN_TEXT}>
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!name || !command) {
                  toast.error("Name and command are required");
                  return;
                }
                const parsedArgs = args
                  .split("\n")
                  .map((a) => a.trim())
                  .filter(Boolean);
                const parsedEnv: Record<string, string> = {};
                for (const line of env.split("\n")) {
                  const idx = line.indexOf("=");
                  if (idx > 0) parsedEnv[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
                }
                const res = await api.createMcpServer({
                  name,
                  owner: ownerOf(scope),
                  command,
                  args: parsedArgs.length > 0 ? parsedArgs : undefined,
                  env: Object.keys(parsedEnv).length > 0 ? parsedEnv : undefined,
                  installCommand: installCmd || undefined,
                });
                setServers((prev) => [...prev, res.server]);
                reset();
                toast.success("MCP server added");
              }}
              className={BTN_PRIMARY}
            >
              Add Server
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}

const SKILL_AGENT_TYPES = [
  { value: "claude-code", label: "Claude Code" },
  { value: "codex", label: "OpenAI Codex" },
  { value: "copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Google Gemini" },
  { value: "opencode", label: "OpenCode" },
  { value: "cursor", label: "Cursor" },
];

type SkillExtraFile = { relativePath: string; content: string };

/** Multi-select agent chips (any number on; none = all agents). */
function AgentChips({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SKILL_AGENT_TYPES.map((a) => {
        const active = selected.includes(a.value);
        return (
          <button
            key={a.value}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(a.value)}
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-colors ${
              active
                ? "bg-primary/10 border-primary text-primary"
                : "bg-bg border-border text-text-muted hover:text-text hover:border-primary/40"
            }`}
          >
            <AgentIcon runtime={a.value} className="w-3 h-3" />
            {a.label}
          </button>
        );
      })}
    </div>
  );
}

function GlobalSkills() {
  const { userId, isAdmin, loaded } = useCurrentUser();
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [prompt, setPrompt] = useState("");
  const [layout, setLayout] = useState<"commands" | "skill-dir">("commands");
  const [files, setFiles] = useState<SkillExtraFile[]>([]);
  const [agentTypes, setAgentTypes] = useState<string[]>([]);
  const [scope, setScope] = useState<PickedScope>("organization");

  const resetForm = () => {
    setShowAdd(false);
    setName("");
    setDescription("");
    setPrompt("");
    setLayout("commands");
    setFiles([]);
    setAgentTypes([]);
  };

  const openAdd = () => {
    setScope(isAdmin ? "organization" : "private");
    setShowAdd(true);
  };

  const toggleAgent = (value: string) => {
    setAgentTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  useEffect(() => {
    api
      .listSkills("global")
      .then((res) => setSkills(res.skills))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const label = "Custom skills";
  const hint = "Slash commands and skills for agents in every repo";
  if (loading || !loaded) return <SkeletonCard label={label} hint={hint} rows={1} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={skills.length ? plural(skills.length, "skill") : undefined}
      actions={
        !showAdd && (
          <button onClick={openAdd} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Written to <code className="text-primary">.claude/commands/</code> or{" "}
        <code className="text-primary">.claude/skills/&lt;name&gt;/</code> before the agent starts.
        Optionally scope by agent type.
      </p>

      {skills.length > 0 && (
        <ScopedRows
          rows={skills}
          viewerId={userId}
          render={(skill: any, rowScope) => {
            const own = ownerScope(skill, userId);
            // Any member changes the organization's skills; someone else's private one is read-only.
            const canEdit = own !== "others";
            const canDelete = canEdit || isAdmin;
            return (
              <ListRow
                key={skill.id}
                title={`/${skill.name}`}
                tags={
                  <>
                    <ScopeTags row={skill} scope={rowScope} viewerId={userId} />
                    {skill.layout === "skill-dir" && (
                      <Tag tone="primary">
                        skill-dir
                        {Array.isArray(skill.files) && skill.files.length > 0
                          ? ` +${skill.files.length}`
                          : ""}
                      </Tag>
                    )}
                    {Array.isArray(skill.agentTypes) && skill.agentTypes.length > 0 && (
                      <Tag>{skill.agentTypes.join(", ")}</Tag>
                    )}
                    {!skill.enabled && <Tag tone="warning">disabled</Tag>}
                  </>
                }
                detail={skill.description}
                actions={
                  <>
                    {canEdit && (
                      <button
                        onClick={async () => {
                          await api.updateSkill(skill.id, { enabled: !skill.enabled });
                          setSkills((prev) =>
                            prev.map((s) =>
                              s.id === skill.id ? { ...s, enabled: !s.enabled } : s,
                            ),
                          );
                        }}
                        className={BTN_ROW}
                      >
                        {skill.enabled ? "Disable" : "Enable"}
                      </button>
                    )}
                    {canDelete && (
                      <button
                        onClick={async () => {
                          await api.deleteSkill(skill.id);
                          setSkills((prev) => prev.filter((s) => s.id !== skill.id));
                          toast.success("Skill removed");
                        }}
                        className={BTN_ROW_DANGER}
                        aria-label={`Remove ${skill.name}`}
                        title={
                          own === "others"
                            ? `Remove ${skill.ownerName ?? "their"}'s private skill`
                            : undefined
                        }
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                }
              />
            );
          }}
        />
      )}

      {skills.length === 0 && !showAdd && (
        <EmptyState
          size="panel"
          icon={Sparkles}
          title="No custom skills"
          description="Write a command or skill once and every agent gets it."
          action={
            <button onClick={openAdd} className={BTN_PRIMARY}>
              <Plus className="w-3.5 h-3.5" />
              Add skill
            </button>
          }
        />
      )}

      {showAdd && (
        <InsetForm>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="run-tests"
                className={INPUT}
              />
            </Field>
            <Field label="Description">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Run the full test suite"
                className={INPUT}
              />
            </Field>
          </div>
          <Field
            label="Layout"
            help={
              layout === "skill-dir" ? (
                <code>.claude/skills/&lt;name&gt;/...</code>
              ) : (
                <code>.claude/commands/&lt;name&gt;.md</code>
              )
            }
          >
            <Segmented
              value={layout}
              onChange={setLayout}
              aria-label="Layout"
              options={[
                { value: "commands", label: "Command" },
                { value: "skill-dir", label: "Skill directory" },
              ]}
            />
          </Field>
          <Field label={layout === "skill-dir" ? "SKILL.md body" : "Prompt (markdown)"}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={6}
              placeholder={
                layout === "skill-dir"
                  ? "Body of SKILL.md. YAML frontmatter is fine if Claude expects it."
                  : "Run the full test suite and analyze any failures..."
              }
              className={MONO_AREA}
            />
          </Field>
          <Field
            label="Agent types"
            help={
              agentTypes.length === 0
                ? "No selection — applies to all agents."
                : `Applies only to: ${agentTypes.join(", ")}`
            }
          >
            <AgentChips selected={agentTypes} onToggle={toggleAgent} />
          </Field>

          {layout === "skill-dir" && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-text-muted">
                  Additional files (under{" "}
                  <code className="text-primary">.claude/skills/{name || "<name>"}/</code>)
                </span>
                <button
                  type="button"
                  onClick={() => setFiles((prev) => [...prev, { relativePath: "", content: "" }])}
                  className="flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  <Plus className="w-3 h-3" />
                  Add file
                </button>
              </div>
              {files.map((f, i) => (
                <div key={i} className="space-y-1.5 p-2 rounded-md border border-border bg-bg">
                  <div className="flex items-center gap-2">
                    <input
                      value={f.relativePath}
                      onChange={(e) =>
                        setFiles((prev) =>
                          prev.map((x, idx) =>
                            idx === i ? { ...x, relativePath: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder="reference.md or scripts/lint.sh"
                      className={inputClass({ size: "sm", className: "flex-1 font-mono" })}
                    />
                    <button
                      type="button"
                      onClick={() => setFiles((prev) => prev.filter((_, idx) => idx !== i))}
                      className={BTN_ROW_DANGER}
                      aria-label="Remove file"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <textarea
                    value={f.content}
                    onChange={(e) =>
                      setFiles((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, content: e.target.value } : x)),
                      )
                    }
                    rows={3}
                    placeholder="File contents"
                    className={inputClass({ size: "sm", className: "font-mono resize-y" })}
                  />
                </div>
              ))}
              {files.length === 0 && (
                <p className="text-[11px] text-text-muted/70">
                  None. SKILL.md is enough for most skills — add files only when you need scripts or
                  supporting docs.
                </p>
              )}
            </div>
          )}

          <OwnerPicker what="skill" value={scope} onChange={setScope} orgNeeds="member" />
          <div className="flex justify-end items-center gap-3">
            <button onClick={resetForm} className={BTN_TEXT}>
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!name || !prompt) {
                  toast.error("Name and prompt are required");
                  return;
                }
                const cleanedFiles =
                  layout === "skill-dir"
                    ? files
                        .map((f) => ({
                          relativePath: f.relativePath.trim(),
                          content: f.content,
                        }))
                        .filter((f) => f.relativePath.length > 0)
                    : undefined;
                const res = await api.createSkill({
                  name,
                  owner: ownerOf(scope),
                  description: description || undefined,
                  prompt,
                  layout,
                  files: cleanedFiles,
                  agentTypes: agentTypes.length > 0 ? agentTypes : undefined,
                });
                setSkills((prev) => [...prev, res.skill]);
                resetForm();
                toast.success("Skill added");
              }}
              className={BTN_PRIMARY}
            >
              Add Skill
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}

function MarketplaceSkills() {
  const { userId, isAdmin, loaded } = useCurrentUser();
  const [skills, setSkills] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [ref, setRef] = useState("main");
  const [subpath, setSubpath] = useState("");
  const [agentTypes, setAgentTypes] = useState<string[]>(["claude-code"]);
  const [scope, setScope] = useState<PickedScope>("organization");

  const refresh = () => {
    api
      .listInstalledSkills()
      .then((res) => setSkills(res.skills))
      .catch(() => {});
  };

  useEffect(() => {
    refresh();
    setLoading(false);
  }, []);

  const resetForm = () => {
    setShowAdd(false);
    setName("");
    setSourceUrl("");
    setRef("main");
    setSubpath("");
    setAgentTypes(["claude-code"]);
  };

  const openAdd = () => {
    setScope(isAdmin ? "organization" : "private");
    setShowAdd(true);
  };

  const toggleAgent = (value: string) => {
    setAgentTypes((prev) =>
      prev.includes(value) ? prev.filter((v) => v !== value) : [...prev, value],
    );
  };

  // Auto-derive a name from the source URL when the user hasn't typed one yet.
  const deriveName = (url: string): string => {
    const m = url.match(/([^/]+?)(?:\.git)?\/?$/);
    if (!m) return "";
    return m[1]
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, "-")
      .slice(0, 64);
  };

  const label = "Marketplace skills";
  const hint = "Installed from a git URL · Claude Code only";
  if (loading || !loaded) return <SkeletonCard label={label} hint={hint} rows={1} />;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={skills.length ? plural(skills.length, "installed", "installed") : undefined}
      actions={
        !showAdd && (
          <button onClick={openAdd} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Install
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        Install a skill from any public git URL (e.g. an Anthropic marketplace skill repo). Files
        are fetched into a shared cache and materialized into{" "}
        <code className="text-primary">.claude/skills/&lt;name&gt;/</code> at task spawn.
      </p>

      {skills.length > 0 && (
        <ScopedRows
          rows={skills}
          viewerId={userId}
          render={(skill: any, rowScope) => {
            const own = ownerScope(skill, userId);
            // Any member changes the organization's skills; someone else's private one is read-only.
            const canEdit = own !== "others";
            const canDelete = canEdit || isAdmin;
            return (
              <ListRow
                key={skill.id}
                title={skill.name}
                tags={
                  <>
                    <ScopeTags row={skill} scope={rowScope} viewerId={userId} />
                    <Tag tone="primary">
                      {skill.ref}
                      {skill.resolvedSha ? ` @${skill.resolvedSha.slice(0, 7)}` : ""}
                    </Tag>
                    {skill.hasExecutableFiles && (
                      <Tag
                        tone="warning"
                        title="This skill ships executable scripts. Review the source before enabling."
                      >
                        <AlertTriangle className="w-3 h-3" /> scripts
                      </Tag>
                    )}
                    {Array.isArray(skill.agentTypes) && skill.agentTypes.length > 0 && (
                      <Tag>{skill.agentTypes.join(", ")}</Tag>
                    )}
                    {!skill.enabled && <Tag tone="warning">disabled</Tag>}
                    {skill.lastSyncError && (
                      <Tag tone="error" title={skill.lastSyncError}>
                        sync failed
                      </Tag>
                    )}
                  </>
                }
                detail={
                  <>
                    {skill.sourceUrl}
                    {skill.subpath !== "." && (
                      <span className="text-text-muted/70"> · {skill.subpath}</span>
                    )}
                  </>
                }
                actions={
                  <>
                    {canEdit && (
                      <>
                        <button
                          onClick={async () => {
                            try {
                              await api.syncInstalledSkill(skill.id);
                              toast.success("Sync queued");
                              setTimeout(refresh, 1500);
                            } catch {
                              toast.error("Sync failed to queue");
                            }
                          }}
                          className={BTN_ROW}
                          title="Force re-sync"
                        >
                          Sync
                        </button>
                        <button
                          onClick={async () => {
                            await api.updateInstalledSkill(skill.id, { enabled: !skill.enabled });
                            setSkills((prev) =>
                              prev.map((s) =>
                                s.id === skill.id ? { ...s, enabled: !s.enabled } : s,
                              ),
                            );
                          }}
                          className={BTN_ROW}
                        >
                          {skill.enabled ? "Disable" : "Enable"}
                        </button>
                      </>
                    )}
                    {canDelete && (
                      <button
                        onClick={async () => {
                          await api.deleteInstalledSkill(skill.id);
                          setSkills((prev) => prev.filter((s) => s.id !== skill.id));
                          toast.success("Skill removed");
                        }}
                        className={BTN_ROW_DANGER}
                        aria-label={`Remove ${skill.name}`}
                        title={
                          own === "others"
                            ? `Remove ${skill.ownerName ?? "their"}'s private skill`
                            : undefined
                        }
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </>
                }
              />
            );
          }}
        />
      )}

      {skills.length === 0 && !showAdd && (
        <EmptyState
          size="panel"
          icon={Store}
          title="No marketplace skills"
          description="Install one from a git repo; Optio keeps it synced."
          action={
            <button onClick={openAdd} className={BTN_PRIMARY}>
              <Plus className="w-3.5 h-3.5" />
              Install skill
            </button>
          }
        />
      )}

      {showAdd && (
        <InsetForm>
          <Field label="Source URL (git)">
            <input
              value={sourceUrl}
              onChange={(e) => {
                setSourceUrl(e.target.value);
                if (!name) setName(deriveName(e.target.value));
              }}
              placeholder="https://github.com/anthropics/skills.git"
              className={`${INPUT} font-mono`}
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="superpowers"
                className={INPUT}
              />
            </Field>
            <Field label="Ref">
              <input
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                placeholder="main"
                className={INPUT}
              />
            </Field>
            <Field label="Subpath (optional)">
              <input
                value={subpath}
                onChange={(e) => setSubpath(e.target.value)}
                placeholder="."
                className={`${INPUT} font-mono`}
              />
            </Field>
          </div>
          <Field
            label="Agent types"
            help="Marketplace skills only inject for Claude Code today; other selections are recorded for future agents."
          >
            <AgentChips selected={agentTypes} onToggle={toggleAgent} />
          </Field>
          <OwnerPicker what="skill" value={scope} onChange={setScope} orgNeeds="member" />
          <div className="flex justify-end items-center gap-3">
            <button onClick={resetForm} className={BTN_TEXT}>
              Cancel
            </button>
            <button
              onClick={async () => {
                if (!name || !sourceUrl) {
                  toast.error("Name and source URL are required");
                  return;
                }
                try {
                  const res = await api.createInstalledSkill({
                    name,
                    owner: ownerOf(scope),
                    sourceUrl,
                    ref: ref || undefined,
                    subpath: subpath || undefined,
                    agentTypes: agentTypes.length > 0 ? agentTypes : undefined,
                  });
                  setSkills((prev) => [...prev, res.skill]);
                  resetForm();
                  toast.success("Skill installed; syncing in background");
                  setTimeout(refresh, 2500);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Could not install skill");
                }
              }}
              className={BTN_PRIMARY}
            >
              Install
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}

function AuthenticationSettings() {
  // Settings → Access → Sign-in: see components/settings/sign-in-settings.tsx.
  return <SignInSettings />;
}

function OptioAgentSettings() {
  const [model, setModel] = useState(DEFAULT_OPTIO_AGENT_MODEL);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [enabledTools, setEnabledTools] = useState<string[]>([...ALL_OPTIO_TOOL_NAMES]);
  const [confirmWrites, setConfirmWrites] = useState(true);
  const [maxTurns, setMaxTurns] = useState(20);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showBasePrompt, setShowBasePrompt] = useState(false);
  const [showTools, setShowTools] = useState(false);

  useEffect(() => {
    api
      .getOptioSettings()
      .then((res) => {
        const s = res.settings;
        setModel(s.model);
        setSystemPrompt(s.systemPrompt);
        // Empty array means "all enabled" (default state)
        setEnabledTools(
          s.enabledTools && s.enabledTools.length > 0 ? s.enabledTools : [...ALL_OPTIO_TOOL_NAMES],
        );
        setConfirmWrites(s.confirmWrites);
        setMaxTurns(s.maxTurns);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    if (enabledTools.length === 0) {
      toast.error("At least one tool must be enabled");
      return;
    }
    setSaving(true);
    try {
      // If all tools are enabled, store empty array (meaning "all")
      const toolsToSave = enabledTools.length === ALL_OPTIO_TOOL_NAMES.length ? [] : enabledTools;
      await api.updateOptioSettings({
        model,
        systemPrompt,
        enabledTools: toolsToSave.length === 0 ? ALL_OPTIO_TOOL_NAMES : toolsToSave,
        confirmWrites,
        maxTurns,
      });
      toast.success("Optio agent settings saved");
    } catch (err) {
      toast.error("Failed to save settings", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleTool = (toolName: string) => {
    setEnabledTools((prev) =>
      prev.includes(toolName) ? prev.filter((t) => t !== toolName) : [...prev, toolName],
    );
  };

  const enableAll = () => setEnabledTools([...ALL_OPTIO_TOOL_NAMES]);
  const disableAll = () => setEnabledTools([]);

  const label = "Optio agent";
  const hint = "The assistant behind Ask Optio";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={4} />;

  const toolCount =
    enabledTools.length === ALL_OPTIO_TOOL_NAMES.length
      ? "all tools"
      : `${enabledTools.length}/${ALL_OPTIO_TOOL_NAMES.length} tools`;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={`${model} · ${toolCount}`}
      bodyClassName="p-4 space-y-5"
    >
      {/* Model: the live list, with each family's "always the latest" alias */}
      <AgentOptionsPicker
        provider="anthropic"
        values={{ claudeModel: model }}
        onChange={(v) => setModel(String(v.claudeModel || DEFAULT_OPTIO_AGENT_MODEL))}
        modelOnly
        latestAliases
      />

      <div className="pt-4 border-t border-border space-y-2">
        <Field
          label="Custom system prompt"
          help="Appended to Optio's base prompt. Add context about your team's workflows, naming conventions, or preferences."
        >
          <textarea
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            rows={5}
            placeholder="e.g., Always use conventional commits. Follow our coding style guide at docs/STYLE.md..."
            className={MONO_AREA}
          />
        </Field>
        <Disclosure
          open={showBasePrompt}
          onToggle={() => setShowBasePrompt(!showBasePrompt)}
          label="About the base system prompt"
        >
          <p className="p-3 rounded-lg bg-bg border border-border text-xs text-text-muted">
            The base system prompt is defined in code and includes instructions for task execution,
            PR creation, and tool usage. Your custom prompt above is appended after the base prompt
            to provide additional context.
          </p>
        </Disclosure>
      </div>

      <div className="pt-4 border-t border-border space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-text-muted">
            Tools <span className="font-normal text-text-muted/70">· {toolCount} enabled</span>
          </span>
          <div className="flex items-center gap-1">
            <button onClick={enableAll} className={BTN_ROW}>
              Enable all
            </button>
            <button onClick={disableAll} className={BTN_ROW}>
              Disable all
            </button>
          </div>
        </div>
        <Disclosure open={showTools} onToggle={() => setShowTools(!showTools)} label="Choose tools">
          <div className="grid grid-cols-1 gap-3">
            {OPTIO_TOOL_CATEGORIES.map((category) => (
              <div key={category.name} className="p-3 rounded-lg bg-bg border border-border">
                <h4 className="text-xs font-medium mb-2">{category.name}</h4>
                <div className="space-y-1.5">
                  {category.tools.map((tool) => (
                    <label
                      key={tool.name}
                      className="flex items-center gap-2 text-xs cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={enabledTools.includes(tool.name)}
                        onChange={() => toggleTool(tool.name)}
                        className="w-3.5 h-3.5 rounded"
                      />
                      <span className="font-medium">{tool.name}</span>
                      <span className="text-text-muted">— {tool.description}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Disclosure>
        {enabledTools.length === 0 && (
          <p className="text-xs text-error flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            At least one tool must be enabled
          </p>
        )}
      </div>

      <div className="pt-4 border-t border-border flex flex-wrap items-start gap-x-8 gap-y-4">
        <Field label="Write operations">
          <Segmented
            value={confirmWrites ? "confirm" : "auto"}
            onChange={(v) => setConfirmWrites(v === "confirm")}
            aria-label="Write operations"
            options={[
              { value: "confirm", label: "Ask first" },
              { value: "auto", label: "Run immediately" },
            ]}
          />
          {!confirmWrites && (
            <p className="text-xs text-warning mt-1.5 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              Optio will act without asking for approval
            </p>
          )}
        </Field>
        <Field label="Max conversation turns" help="Per session (5–50).">
          <NumberInput
            min={5}
            max={50}
            value={maxTurns}
            onChange={(v) => setMaxTurns(v)}
            fallback={25}
            className={inputClass({ className: "w-28" })}
          />
        </Field>
      </div>

      <CardFooter>
        <button
          onClick={handleSave}
          disabled={saving || enabledTools.length === 0}
          className={BTN_PRIMARY}
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          {saving ? "Saving..." : "Save Settings"}
        </button>
      </CardFooter>
    </SectionCard>
  );
}

function GitHubTokenManager() {
  const [status, setStatus] = useState<"valid" | "expired" | "missing" | "error" | null>(null);
  const [source, setSource] = useState<"pat" | "github_app" | undefined>();
  const [user, setUser] = useState<{ login: string; name: string } | undefined>();
  const [message, setMessage] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [newToken, setNewToken] = useState("");
  const [rotating, setRotating] = useState(false);
  const [showRotateForm, setShowRotateForm] = useState(false);

  const checkStatus = async () => {
    setLoading(true);
    try {
      const res = await api.getGithubTokenStatus();
      setStatus(res.status);
      setSource(res.source);
      setUser(res.user);
      setMessage(res.message ?? res.error);
    } catch {
      setStatus("error");
      setMessage("Failed to check token status");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const handleRotate = async () => {
    if (!newToken.trim()) return;
    setRotating(true);
    try {
      const res = await api.rotateGithubToken(newToken.trim());
      if (res.success) {
        toast.success(res.message ?? "GitHub token replaced successfully");
        setNewToken("");
        setShowRotateForm(false);
        checkStatus();
      } else {
        toast.error(res.error ?? "Token validation failed");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to replace token");
    } finally {
      setRotating(false);
    }
  };

  const label = "GitHub token";
  const hint = "PR watching, issue sync, and repo detection";
  if (loading) return <SkeletonCard label={label} hint={hint} rows={1} />;

  const summary =
    status === "valid"
      ? user
        ? `valid · ${user.login}`
        : source === "github_app"
          ? "valid · GitHub App"
          : "valid"
      : status === "expired"
        ? "expired"
        : status === "missing"
          ? "not set"
          : "unverified";

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={summary}
      summaryIcon={<BrandIcon brand="github" className="w-3 h-3" />}
      actions={
        <button onClick={checkStatus} className={BTN_HEADER}>
          <RefreshCw className="w-3 h-3" />
          Refresh
        </button>
      }
      bodyClassName="p-4 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {status === "valid" ? (
            <CheckCircle2 className="w-5 h-5 text-success shrink-0" />
          ) : status === "expired" ? (
            <AlertTriangle className="w-5 h-5 text-warning shrink-0" />
          ) : status === "missing" ? (
            <XCircle className="w-5 h-5 text-error shrink-0" />
          ) : (
            <AlertTriangle className="w-5 h-5 text-text-muted shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {status === "valid"
                ? "Token is valid"
                : status === "expired"
                  ? "Token is expired or revoked"
                  : status === "missing"
                    ? "No token configured"
                    : "Unable to verify token"}
            </p>
            {user && (
              <p className="text-xs text-text-muted">
                Authenticated as <span className="font-medium text-text">{user.login}</span>
                {user.name && ` (${user.name})`}
              </p>
            )}
            {source === "github_app" && (
              <p className="text-xs text-text-muted">Using GitHub App integration</p>
            )}
            {message && !user && <p className="text-xs text-text-muted">{message}</p>}
          </div>
        </div>
        {source !== "github_app" && !showRotateForm && (
          <button
            onClick={() => setShowRotateForm(true)}
            className={status === "missing" ? BTN_PRIMARY : BTN_SECONDARY}
          >
            <KeyRound className="w-3.5 h-3.5" />
            {status === "missing" ? "Add Token" : "Replace Token"}
          </button>
        )}
      </div>

      {(status === "expired" || status === "missing") && (
        <div
          className={`flex items-start gap-2 p-3 rounded-lg text-xs ${
            status === "expired"
              ? "bg-warning/10 border border-warning/20 text-warning"
              : "bg-error/10 border border-error/20 text-error"
          }`}
        >
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">
              {status === "expired"
                ? "Your GitHub token has expired or been revoked"
                : "No GitHub token is configured"}
            </p>
            <p className="mt-0.5 opacity-80">
              PR watching, issue sync, and repo detection require a valid GitHub token. Replace it
              below to restore these features.
            </p>
          </div>
        </div>
      )}

      {showRotateForm && (
        <InsetForm>
          <p className="text-xs text-text-muted">
            Enter a new GitHub Personal Access Token. The token will be validated before replacing
            the existing one.
          </p>
          <input
            type="password"
            value={newToken}
            onChange={(e) => setNewToken(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              const pasted = e.clipboardData.getData("text").trim();
              if (pasted) setNewToken(pasted);
            }}
            placeholder="ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
            className={`${INPUT} font-mono`}
          />
          <div className="flex justify-end items-center gap-3">
            <button
              onClick={() => {
                setShowRotateForm(false);
                setNewToken("");
              }}
              className={BTN_TEXT}
            >
              Cancel
            </button>
            <button
              onClick={handleRotate}
              disabled={!newToken.trim() || rotating}
              className={BTN_PRIMARY}
            >
              {rotating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {rotating ? "Validating..." : "Validate & Save"}
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}

const TICKET_SOURCES = [
  { value: "github", label: "GitHub Issues" },
  { value: "jira", label: "Jira" },
  { value: "linear", label: "Linear" },
  { value: "notion", label: "Notion" },
] as const;

function TicketIntegration() {
  const [syncing, setSyncing] = useState(false);
  const [providers, setProviders] = useState<any[] | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [newProviderSource, setNewProviderSource] = useState("github");
  const [providerConfig, setProviderConfig] = useState<Record<string, string>>({});
  const [savingProvider, setSavingProvider] = useState(false);

  useEffect(() => {
    api
      .listTicketProviders()
      .then((res) => setProviders(res.providers))
      .catch(() => setProviders([]));
  }, []);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await api.syncTickets();
      toast.success(`Synced ${res.synced} tickets`);
    } catch (err) {
      toast.error("Sync failed", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSyncing(false);
    }
  };

  const handleAddProvider = async () => {
    setSavingProvider(true);
    try {
      const config: Record<string, unknown> = { ...providerConfig, label: "optio" };
      await api.createTicketProvider({ source: newProviderSource, config });
      const res = await api.listTicketProviders();
      setProviders(res.providers);
      setShowAddProvider(false);
      setProviderConfig({});
      setNewProviderSource("github");
      toast.success("Ticket provider added");
    } catch (err) {
      toast.error("Failed to add provider", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSavingProvider(false);
    }
  };

  const handleDeleteProvider = async (id: string) => {
    if (!confirm("Remove this ticket provider? This cannot be undone.")) return;
    try {
      await api.deleteTicketProvider(id);
      setProviders((prev) => (prev ?? []).filter((p) => p.id !== id));
      toast.success("Provider removed");
    } catch {
      toast.error("Failed to remove provider");
    }
  };

  const handleReEnableProvider = async (id: string) => {
    try {
      await api.reEnableTicketProvider(id);
      const res = await api.listTicketProviders();
      setProviders(res.providers);
      toast.success("Provider re-enabled");
    } catch (err) {
      toast.error("Failed to re-enable provider", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const providerFields: Record<string, { key: string; label: string; type?: string }[]> = {
    github: [
      { key: "owner", label: "Owner" },
      { key: "repo", label: "Repository" },
    ],
    jira: [
      { key: "baseUrl", label: "Jira URL (e.g. https://company.atlassian.net)" },
      { key: "email", label: "Email" },
      { key: "apiToken", label: "API Token", type: "password" },
      { key: "projectKey", label: "Project Key (optional)" },
    ],
    linear: [
      { key: "apiKey", label: "API Key", type: "password" },
      { key: "teamId", label: "Team ID" },
    ],
    notion: [
      { key: "apiKey", label: "Integration Token", type: "password" },
      { key: "databaseId", label: "Database ID" },
    ],
  };

  const label = "Tickets";
  const hint = (
    <>
      Syncs issues labeled <code className="text-primary">optio</code>
    </>
  );
  if (providers === null) return <SkeletonCard label={label} hint={hint} rows={1} />;

  const failing = providers.filter((p) => p.hasAuthFailure || !p.enabled).length;

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={
        providers.length
          ? `${plural(providers.length, "provider")}${failing ? ` · ${failing} need attention` : ""}`
          : undefined
      }
      actions={
        <>
          {providers.length > 0 && (
            <button onClick={handleSync} disabled={syncing} className={BTN_HEADER}>
              {syncing ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Sync Now
            </button>
          )}
          {!showAddProvider && (
            <button onClick={() => setShowAddProvider(true)} className={BTN_HEADER}>
              <Plus className="w-3.5 h-3.5" />
              Add Provider
            </button>
          )}
        </>
      }
      bodyClassName="p-4 space-y-3"
    >
      {providers.length > 0 ? (
        <ul className={LIST}>
          {providers.map((p: any) => {
            const brand = brandFor(p.source);
            return (
              <li key={p.id} className="px-3 py-2.5 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="relative grid place-items-center w-7 h-7 rounded-md border border-border bg-bg-card text-text-muted shrink-0">
                      {brand ? (
                        <BrandIcon brand={brand} className="w-3.5 h-3.5" />
                      ) : (
                        <Ticket className="w-3.5 h-3.5" />
                      )}
                      <span
                        className={`absolute -right-0.5 -bottom-0.5 w-2 h-2 rounded-full ring-2 ring-bg ${
                          p.hasAuthFailure ? "bg-error" : p.enabled ? "bg-success" : "bg-text-muted"
                        }`}
                      />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize">{p.source}</span>
                        {!p.enabled && <Tag tone="error">Disabled</Tag>}
                        {p.hasAuthFailure && p.enabled && <Tag tone="error">Token invalid</Tag>}
                      </div>
                      <p className="text-xs text-text-muted truncate">
                        {p.source === "github" &&
                          p.config?.owner &&
                          `${p.config.owner}/${p.config.repo}`}
                        {p.source === "notion" &&
                          p.config?.databaseId &&
                          `Database: ${p.config.databaseId}`}
                        {p.source === "linear" && p.config?.teamId && `Team: ${p.config.teamId}`}
                        {p.source === "jira" && p.config?.baseUrl && `${p.config.baseUrl}`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(p.hasAuthFailure || !p.enabled) && (
                      <button
                        onClick={() => handleReEnableProvider(p.id)}
                        className={BTN_HEADER}
                        title="Clear errors and re-enable this provider"
                      >
                        <RefreshCw className="w-3 h-3" />
                        Re-enable
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteProvider(p.id)}
                      className={BTN_ROW_DANGER}
                      title="Remove provider"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                {p.lastError && (
                  <div className="ml-10 p-2 rounded-md bg-error/5 border border-error/20">
                    <p className="text-xs text-error">{p.lastError}</p>
                    <p className="text-xs text-text-muted mt-0.5">
                      {p.lastErrorAt && `Last failure: ${new Date(p.lastErrorAt).toLocaleString()}`}
                      {p.consecutiveFailures > 0 &&
                        ` (${p.consecutiveFailures} consecutive failures)`}
                    </p>
                    <p className="text-xs text-text-muted mt-1">
                      Refresh your token and click Re-enable to resume syncing.
                    </p>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        !showAddProvider && (
          <EmptyState
            size="panel"
            icon={Ticket}
            title="No ticket providers"
            description="Connect GitHub Issues, Jira, Linear, or Notion to turn labeled tickets into work."
            action={
              <button onClick={() => setShowAddProvider(true)} className={BTN_PRIMARY}>
                <Plus className="w-3.5 h-3.5" />
                Add Provider
              </button>
            }
          />
        )
      )}

      {showAddProvider && (
        <InsetForm>
          <Field label="Provider">
            <Segmented
              value={newProviderSource}
              onChange={(v) => {
                setNewProviderSource(v);
                setProviderConfig({});
              }}
              aria-label="Provider"
              wrap
              options={TICKET_SOURCES.map((s) => ({
                value: s.value,
                label: s.label,
                icon: <BrandIcon brand={s.value} className="w-3.5 h-3.5" />,
              }))}
            />
          </Field>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {providerFields[newProviderSource]?.map((field) => (
              <Field key={field.key} label={field.label}>
                <input
                  type={field.type || "text"}
                  value={providerConfig[field.key] || ""}
                  onChange={(e) =>
                    setProviderConfig((prev) => ({ ...prev, [field.key]: e.target.value }))
                  }
                  className={INPUT}
                />
              </Field>
            ))}
          </div>
          <div className="flex justify-end items-center gap-3">
            <button
              onClick={() => {
                setShowAddProvider(false);
                setProviderConfig({});
              }}
              className={BTN_TEXT}
            >
              Cancel
            </button>
            <button onClick={handleAddProvider} disabled={savingProvider} className={BTN_PRIMARY}>
              {savingProvider && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Save
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}

/** An uppercase group label above a run of cards (as on the Overview). */
/**
 * The deployment's own secrets — agent sign-in, Optio settings, git access —
 * which the Connections catalog leaves out. Everything work connects to
 * (service credentials, bare secrets, MCP servers) is under Library → Connections.
 */
function DeploymentSecrets() {
  const { isAdmin, loaded } = useCurrentUser();
  const [secrets, setSecrets] = useState<VisibleSecret[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const load = () =>
    api
      .listSecrets(undefined, { deployment: true })
      .then((res) => setSecrets(res.secrets))
      .catch(() => {})
      .finally(() => setLoading(false));

  useEffect(() => {
    void load();
  }, []);

  const label = "Deployment secrets";
  const hint = "Agent sign-in, Optio settings, git access";
  if (loading || !loaded) return <SkeletonCard label={label} hint={hint} rows={2} />;

  const reset = () => {
    setShowAdd(false);
    setName("");
    setValue("");
  };

  const add = async () => {
    if (!name || !value) {
      toast.error("Name and value are required");
      return;
    }
    setSaving(true);
    try {
      await api.createSecret({ name, value, scope: "global" });
      toast.success("Secret saved", { description: `${name} has been encrypted and stored.` });
      reset();
      void load();
    } catch (err) {
      toast.error("Failed to save secret", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSaving(false);
    }
  };

  const remove = async (secret: VisibleSecret) => {
    if (!window.confirm(`Delete ${secret.name}? Pods stop receiving it.`)) return;
    try {
      await api.deleteSecret(secret.name, secret.scope);
      toast.success("Secret deleted");
      void load();
    } catch {
      toast.error("Failed to delete secret");
    }
  };

  const scopeTag = (scope: string) =>
    scope === "global" ? "all repos" : scope.replace(/^https?:\/\//, "");

  return (
    <SectionCard
      label={label}
      hint={hint}
      summary={secrets.length ? plural(secrets.length, "secret") : undefined}
      actions={
        isAdmin &&
        !showAdd && (
          <button onClick={() => setShowAdd(true)} className={BTN_HEADER}>
            <Plus className="w-3.5 h-3.5" />
            Add
          </button>
        )
      }
      bodyClassName="p-4 space-y-3"
    >
      <p className="text-xs text-text-muted">
        The deployment's own secrets — agent sign-in, Optio settings, git access. Everything work
        connects to lives under Library → Connections.
      </p>

      {secrets.length > 0 ? (
        <ul className={LIST}>
          {secrets.map((secret) => (
            <ListRow
              key={secret.id}
              title={
                <span className="inline-flex items-center gap-2 font-mono">
                  <KeyRound className="w-3.5 h-3.5 text-text-muted shrink-0" />
                  {secret.name}
                </span>
              }
              tags={<Tag>{scopeTag(secret.scope)}</Tag>}
              actions={
                isAdmin && (
                  <button
                    onClick={() => remove(secret)}
                    className={BTN_ROW_DANGER}
                    aria-label={`Delete ${secret.name}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )
              }
            />
          ))}
        </ul>
      ) : (
        !showAdd && (
          <p className="text-xs text-text-muted">
            No deployment secrets yet — add the agent's API key or an OAuth token here.
          </p>
        )
      )}

      {showAdd && (
        <InsetForm>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ANTHROPIC_API_KEY"
                aria-label="Deployment secret name"
                className={inputClass({ className: "font-mono" })}
              />
            </Field>
            <Field label="Value">
              <input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="sk-ant-..."
                aria-label="Deployment secret value"
                autoComplete="off"
                className={INPUT}
              />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={reset} className={BTN_TEXT}>
              Cancel
            </button>
            <button onClick={add} disabled={saving} className={BTN_PRIMARY}>
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
        </InsetForm>
      )}
    </SectionCard>
  );
}

export default function SettingsPage() {
  usePageTitle("Settings");

  return (
    <div className="page-column py-6">
      <PageHeader
        icon={SettingsIcon}
        title="Settings"
        description="Defaults for every agent, how people and clients sign in, and the integrations Optio injects into pods."
      />
      <SettingsLayout
        sections={[
          {
            id: "agents",
            title: "Agents",
            description: "Default behavior and prompts for your agents.",
            content: (
              <>
                <OptioAgentSettings />
                <PromptTemplateEditor />
                <DefaultReviewEditor />
              </>
            ),
          },
          {
            id: "access",
            title: "Access",
            description: "Sign-in, API keys, and the accounts your agents use.",
            content: (
              <>
                <AuthenticationSettings />
                <ApiKeysManager />
                <GitHubTokenManager />
                <div id="model-providers">
                  <ModelProvidersManager />
                </div>
              </>
            ),
          },
          {
            id: "configuration",
            title: "Configuration",
            description: "Keep your deployment configuration in version control.",
            content: <ConfigAsCodeSettings />,
          },
          {
            id: "integrations",
            title: "Integrations",
            description: "Tools, credentials, and skills available to your work.",
            content: (
              <>
                <TicketIntegration />
                <GlobalMcpServers />
                <DeploymentSecrets />
                <GlobalSkills />
                <MarketplaceSkills />
              </>
            ),
          },
          {
            id: "notifications",
            title: "Notifications",
            description: "Choose what needs your attention and where to hear about it.",
            content: <NotificationPreferences />,
          },
        ]}
      />
    </div>
  );
}
