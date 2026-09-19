"use client";

/**
 * Local Automations: "when X happens, run this agent on my machine".
 *
 * An automation (a `local_blueprints` row) is Who (agent) + What (prompt) +
 * Where (host / dir / repo — or the event's repo) + When (triggers) + Then
 * (keep the session open for chat, or exit when done). Triggers are the
 * generic schedule / webhook / ticket ones plus GitHub / Slack / Linear event
 * triggers fed by the signed ingress endpoints.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "@/lib/api-client";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Bot,
  ChevronDown,
  ChevronRight,
  Clock,
  Github,
  Hash,
  Loader2,
  MessageSquare,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Ticket,
  Trash2,
  Webhook,
  Zap,
} from "lucide-react";

type TriggerType = "schedule" | "webhook" | "ticket" | "github" | "slack" | "linear";
type Agent = "claude-code" | "codex" | "cursor" | "gemini" | "opencode";
type SessionMode = "interactive" | "headless";

const AGENTS: Agent[] = ["claude-code", "codex", "cursor", "gemini", "opencode"];
const AGENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  gemini: "Gemini",
  opencode: "OpenCode",
};
const TICKET_SOURCES = ["github", "gitlab", "linear", "jira", "notion"] as const;
const GITHUB_KINDS: Array<{ value: string; label: string; personal: boolean }> = [
  { value: "review_requested", label: "Review requested from me", personal: true },
  { value: "mentioned", label: "I'm @-mentioned", personal: true },
  { value: "assigned", label: "Assigned to me", personal: true },
  { value: "pr_opened", label: "Any PR opened", personal: false },
  { value: "issue_opened", label: "Any issue opened", personal: false },
];
const LINEAR_KINDS: Array<{ value: string; label: string; personal: boolean }> = [
  { value: "assigned", label: "Assigned to me", personal: true },
  { value: "mentioned", label: "I'm @-mentioned", personal: true },
  { value: "created", label: "Any issue created", personal: false },
  { value: "labeled", label: "A label is added", personal: false },
];

const TRIGGER_META: Record<TriggerType, { label: string; icon: any }> = {
  schedule: { label: "Schedule", icon: Clock },
  webhook: { label: "Webhook", icon: Webhook },
  ticket: { label: "Ticket sync", icon: Ticket },
  github: { label: "GitHub", icon: Github },
  slack: { label: "Slack", icon: Hash },
  linear: { label: "Linear", icon: Zap },
};

/** Prompt params each trigger source provides, for the hint strip. */
const PARAM_HINTS: Record<string, string[]> = {
  github: [
    "event",
    "kind",
    "repo",
    "repoUrl",
    "number",
    "title",
    "body",
    "url",
    "author",
    "headBranch",
    "baseBranch",
    "commentBody",
    "commentUrl",
  ],
  slack: ["channelId", "userId", "text", "ts", "threadTs", "permalink"],
  linear: [
    "event",
    "identifier",
    "title",
    "description",
    "url",
    "labels",
    "teamKey",
    "assignee",
    "priority",
    "state",
    "commentBody",
    "actor",
  ],
  ticket: [
    "ticketSource",
    "ticketExternalId",
    "ticketTitle",
    "ticketBody",
    "ticketUrl",
    "ticketLabels",
  ],
  webhook: ["(fields mapped from the payload)"],
  schedule: [],
};

export function triggerSummary(trigger: any): string {
  const c = (trigger.config ?? {}) as Record<string, any>;
  switch (trigger.type) {
    case "schedule":
      return String(c.cronExpression ?? "");
    case "webhook":
      return `POST /api/hooks/${String(c.path ?? "")}`;
    case "ticket": {
      const labels = Array.isArray(c.labels) ? (c.labels as string[]) : [];
      return `${String(c.source ?? "any source")}${labels.length ? ` · ${labels.join(", ")}` : ""}`;
    }
    case "github": {
      const events = Array.isArray(c.events) && c.events.length ? c.events.join(", ") : "any";
      const repos = Array.isArray(c.repos) && c.repos.length ? ` in ${c.repos.join(", ")}` : "";
      return `${events}${c.login ? ` → @${c.login}` : ""}${repos}`;
    }
    case "slack":
      return `${c.channelId ?? "?"}${c.mentionOnly ? " (@-mentions)" : ""}${c.keyword ? ` · "${c.keyword}"` : ""}`;
    case "linear": {
      const events = Array.isArray(c.events) && c.events.length ? c.events.join(", ") : "any";
      const teams = Array.isArray(c.teams) && c.teams.length ? ` in ${c.teams.join(", ")}` : "";
      return `${events}${c.user ? ` → ${c.user}` : ""}${teams}`;
    }
    default:
      return "";
  }
}

interface Preset {
  id: string;
  title: string;
  blurb: string;
  icon: any;
  form: Partial<FormState>;
  trigger?: { type: TriggerType; config: Record<string, unknown> };
}

const PRESETS: Preset[] = [
  {
    id: "pr-review",
    title: "Review PRs I'm tagged on",
    blurb: "GitHub asks for my review → an agent reviews the PR in my checkout and reports back.",
    icon: Github,
    form: {
      name: "PR review requested",
      agent: "claude-code",
      sessionMode: "headless",
      locationKind: "event",
      commandTemplate:
        "I was asked to review {{url}} ({{repo}} #{{number}}: {{title}}).\n\n" +
        "Fetch the branch `{{headBranch}}`, read the diff against `{{baseBranch}}`, and review it for " +
        "correctness, missing tests, and anything risky. Post your review as a comment on the PR " +
        "with `gh pr review`, requesting changes only if something is actually wrong. " +
        "Finish with a short summary of what you found.",
    },
    trigger: { type: "github", config: { events: ["review_requested", "mentioned"], login: "" } },
  },
  {
    id: "slack-channel",
    title: "Act on a Slack channel",
    blurb: "A message lands in a channel → an agent picks it up with the message as its prompt.",
    icon: Hash,
    form: {
      name: "Slack channel request",
      agent: "claude-code",
      sessionMode: "interactive",
      locationKind: "event",
      commandTemplate:
        "A teammate posted this in Slack ({{permalink}}):\n\n{{text}}\n\n" +
        "Work out what they need, do it, and summarize what you did. If you can't finish " +
        "without more information, say exactly what you need.",
    },
    trigger: { type: "slack", config: { channelId: "", mentionOnly: false } },
  },
  {
    id: "linear-triage",
    title: "Triage Linear tickets assigned to me",
    blurb: "A Linear issue is assigned to me → an agent triages it and opens a PR.",
    icon: Zap,
    form: {
      name: "Linear ticket triage",
      agent: "claude-code",
      sessionMode: "headless",
      locationKind: "dir",
      commandTemplate:
        "Triage Linear issue {{identifier}}: {{title}}\n{{url}}\n\n{{description}}\n\n" +
        "Reproduce or locate the problem in this repo, implement a fix on a new branch named " +
        "`{{identifier}}-fix`, add or update tests, and open a pull request with `gh pr create` " +
        "that references {{identifier}}. If the issue isn't actionable from this repo, explain why.",
    },
    trigger: { type: "linear", config: { events: ["assigned", "mentioned"], user: "" } },
  },
];

interface FormState {
  name: string;
  description: string;
  hostId: string;
  locationKind: "event" | "dir" | "repoUrl";
  dir: string;
  repoUrl: string;
  agent: "" | Agent;
  commandTemplate: string;
  sessionMode: SessionMode;
  spawnMode: "auto" | "hold";
}

const EMPTY_FORM: FormState = {
  name: "",
  description: "",
  hostId: "",
  locationKind: "event",
  dir: "",
  repoUrl: "",
  agent: "claude-code",
  commandTemplate: "",
  sessionMode: "interactive",
  spawnMode: "auto",
};

function formFromBlueprint(bp: any): FormState {
  return {
    name: bp.name ?? "",
    description: bp.description ?? "",
    hostId: bp.hostId ?? "",
    locationKind: bp.dir ? "dir" : bp.repoUrl ? "repoUrl" : "event",
    dir: bp.dir ?? "",
    repoUrl: bp.repoUrl ?? "",
    agent: bp.agent ?? "",
    commandTemplate: bp.commandTemplate ?? "",
    sessionMode: bp.sessionMode ?? "interactive",
    spawnMode: bp.spawnMode ?? "auto",
  };
}

const input =
  "w-full px-3 py-2 rounded-lg bg-bg border border-border text-sm focus:outline-none focus:border-primary";
const smallInput =
  "px-2 py-1.5 rounded bg-bg-card border border-border text-xs focus:outline-none focus:border-primary";

export function AutomationsSection({ hosts }: { hosts: any[] }) {
  const [open, setOpen] = useState(false);
  const [blueprints, setBlueprints] = useState<any[]>([]);
  const [triggersById, setTriggersById] = useState<Record<string, any[]>>({});
  const [loaded, setLoaded] = useState(false);
  const [editor, setEditor] = useState<
    { mode: "create"; preset?: Preset } | { mode: "edit"; blueprint: any } | null
  >(null);

  const refetch = async () => {
    try {
      const res = await api.listLocalBlueprints();
      setBlueprints(res.blueprints);
      const entries = await Promise.all(
        res.blueprints.map(async (bp: any) => {
          try {
            const t = await api.listLocalBlueprintTriggers(bp.id);
            return [bp.id, t.triggers] as const;
          } catch {
            return [bp.id, []] as const;
          }
        }),
      );
      setTriggersById(Object.fromEntries(entries));
    } catch {
      /* the section stays empty; the toast on actions reports real errors */
    }
  };

  useEffect(() => {
    if (!open || loaded) return;
    refetch().then(() => setLoaded(true));
  }, [open, loaded]);

  const handleDelete = async (bp: any) => {
    if (!confirm(`Delete automation "${bp.name}" and its triggers?`)) return;
    try {
      await api.deleteLocalBlueprint(bp.id);
      setBlueprints((prev) => prev.filter((b) => b.id !== bp.id));
      toast.success("Automation deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete automation");
    }
  };

  const handleToggle = async (bp: any) => {
    try {
      const res = await api.updateLocalBlueprint(bp.id, { enabled: !bp.enabled });
      setBlueprints((prev) => prev.map((b) => (b.id === bp.id ? res.blueprint : b)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update automation");
    }
  };

  const handleRun = async (bp: any) => {
    try {
      const res = await api.spawnLocalBlueprint(bp.id);
      toast.success(`Started "${res.terminal.title}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start");
    }
  };

  return (
    <section className="mt-8">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-sm font-medium text-text-muted hover:text-text transition-colors"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        <Sparkles className="w-4 h-4" />
        Automations
        {loaded && blueprints.length > 0 && (
          <span className="text-xs text-text-muted/60">({blueprints.length})</span>
        )}
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          {!loaded ? (
            <div className="flex items-center gap-2 py-4 text-text-muted text-sm">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading automations...
            </div>
          ) : (
            <>
              {blueprints.length === 0 && !editor && (
                <p className="text-xs text-text-muted">
                  Nothing wired up yet. An automation runs an agent on your machine when something
                  happens — a review request on GitHub, a message in a Slack channel, a Linear
                  ticket landing on you, a schedule, or a webhook.
                </p>
              )}

              {blueprints.map((bp) => (
                <AutomationRow
                  key={bp.id}
                  blueprint={bp}
                  hosts={hosts}
                  triggers={triggersById[bp.id] ?? []}
                  onTriggers={(next) => setTriggersById((prev) => ({ ...prev, [bp.id]: next }))}
                  onDelete={() => handleDelete(bp)}
                  onToggle={() => handleToggle(bp)}
                  onRun={() => handleRun(bp)}
                  onEdit={() => setEditor({ mode: "edit", blueprint: bp })}
                />
              ))}

              {editor ? (
                <AutomationEditor
                  key={
                    editor.mode === "edit" ? editor.blueprint.id : `new-${editor.preset?.id ?? ""}`
                  }
                  hosts={hosts}
                  initial={
                    editor.mode === "edit"
                      ? formFromBlueprint(editor.blueprint)
                      : { ...EMPTY_FORM, ...(editor.preset?.form ?? {}) }
                  }
                  pendingTrigger={editor.mode === "create" ? editor.preset?.trigger : undefined}
                  blueprintId={editor.mode === "edit" ? editor.blueprint.id : undefined}
                  onCancel={() => setEditor(null)}
                  onSaved={(bp, trigger) => {
                    setBlueprints((prev) =>
                      prev.some((b) => b.id === bp.id)
                        ? prev.map((b) => (b.id === bp.id ? bp : b))
                        : [bp, ...prev],
                    );
                    if (trigger) {
                      setTriggersById((prev) => ({
                        ...prev,
                        [bp.id]: [...(prev[bp.id] ?? []), trigger],
                      }));
                    }
                    setEditor(null);
                  }}
                />
              ) : (
                <div className="space-y-2">
                  <div className="grid gap-2 sm:grid-cols-3">
                    {PRESETS.map((preset) => {
                      const Icon = preset.icon;
                      return (
                        <button
                          key={preset.id}
                          onClick={() => setEditor({ mode: "create", preset })}
                          className="text-left rounded-lg border border-dashed border-border p-3 hover:border-primary/50 hover:bg-primary/5 transition-colors"
                        >
                          <div className="flex items-center gap-2 text-sm font-medium">
                            <Icon className="w-4 h-4 text-primary" />
                            {preset.title}
                          </div>
                          <p className="text-[11px] text-text-muted mt-1 leading-snug">
                            {preset.blurb}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                  <button
                    onClick={() => setEditor({ mode: "create" })}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-dashed border-border text-xs text-text-muted hover:text-text hover:border-primary/40 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                    New automation from scratch
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}

function AutomationRow({
  blueprint,
  hosts,
  triggers,
  onTriggers,
  onDelete,
  onToggle,
  onRun,
  onEdit,
}: {
  blueprint: any;
  hosts: any[];
  triggers: any[];
  onTriggers: (next: any[]) => void;
  onDelete: () => void;
  onToggle: () => void;
  onRun: () => void;
  onEdit: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const host = hosts.find((h) => h.id === blueprint.hostId);

  const run = async () => {
    setRunning(true);
    await onRun();
    setRunning(false);
  };

  const where = blueprint.dir
    ? blueprint.dir
    : blueprint.repoUrl
      ? blueprint.repoUrl
      : "the event's repo";

  return (
    <div className="rounded-lg border border-border bg-bg-card">
      <div className="flex items-start gap-3 p-3">
        <button
          onClick={() => setExpanded(!expanded)}
          className="mt-0.5 text-text-muted hover:text-text transition-colors"
          aria-label={expanded ? "Collapse" : "Expand triggers"}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{blueprint.name}</span>
            {blueprint.agent ? (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-primary/30 bg-primary/10 text-primary">
                <Bot className="w-3 h-3" />
                {AGENT_LABELS[blueprint.agent] ?? blueprint.agent}
              </span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-bg text-text-muted">
                shell
              </span>
            )}
            {blueprint.agent && (
              <span
                className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-border bg-bg text-text-muted"
                title={
                  blueprint.sessionMode === "headless"
                    ? "Runs one turn and exits; the result lands in Needs you and can be resumed as a chat"
                    : "Stays open at the prompt so you can chat with it when you're ready"
                }
              >
                <MessageSquare className="w-3 h-3" />
                {blueprint.sessionMode === "headless" ? "exit when done" : "keeps session open"}
              </span>
            )}
            {blueprint.spawnMode === "hold" && (
              <span className="text-[10px] px-1.5 py-0.5 rounded border border-border bg-bg text-text-muted uppercase tracking-wide">
                hold
              </span>
            )}
          </div>
          <div className="text-[11px] text-text-muted mt-0.5 truncate">
            <span className="font-mono">{where}</span>
            {host ? ` on ${host.name}` : ""}
            {" · "}
            {blueprint.commandTemplate.split("\n")[0]}
          </div>
          {triggers.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {triggers.map((t) => {
                const meta = TRIGGER_META[t.type as TriggerType];
                const Icon = meta?.icon ?? Play;
                return (
                  <span
                    key={t.id}
                    className={cn(
                      "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] max-w-full",
                      t.enabled
                        ? "border-border bg-bg text-text-muted"
                        : "border-border/50 text-text-muted/50 line-through",
                    )}
                    title={triggerSummary(t)}
                  >
                    <Icon className="w-3 h-3 shrink-0" />
                    <span className="truncate">
                      {meta?.label ?? t.type}: {triggerSummary(t)}
                    </span>
                  </span>
                );
              })}
            </div>
          )}
        </div>
        <div className="shrink-0 flex items-center gap-1">
          <button
            onClick={onToggle}
            className={cn(
              "px-2 py-1 rounded-md text-[11px] font-medium transition-colors",
              blueprint.enabled
                ? "bg-success/10 text-success"
                : "bg-bg border border-border text-text-muted hover:text-text",
            )}
            title={blueprint.enabled ? "Enabled — click to pause" : "Paused — click to enable"}
          >
            {blueprint.enabled ? "On" : "Paused"}
          </button>
          <button
            onClick={run}
            disabled={running}
            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-primary text-white text-[11px] font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
            title="Run now"
          >
            {running ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
            Run
          </button>
          <button
            onClick={onEdit}
            className="p-1.5 rounded-md text-text-muted hover:text-text transition-colors"
            title="Edit automation"
            aria-label="Edit"
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onDelete}
            className="p-1.5 rounded-md text-text-muted hover:text-error transition-colors"
            title="Delete automation"
            aria-label="Delete"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {expanded && (
        <TriggerList blueprintId={blueprint.id} triggers={triggers} onChange={onTriggers} />
      )}
    </div>
  );
}

function TriggerList({
  blueprintId,
  triggers,
  onChange,
}: {
  blueprintId: string;
  triggers: any[];
  onChange: (next: any[]) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);

  const handleDelete = async (triggerId: string) => {
    try {
      await api.deleteLocalBlueprintTrigger(blueprintId, triggerId);
      onChange(triggers.filter((t) => t.id !== triggerId));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete trigger");
    }
  };

  const handleToggle = async (t: any) => {
    try {
      const res = await api.updateLocalBlueprintTrigger(blueprintId, t.id, { enabled: !t.enabled });
      onChange(triggers.map((x) => (x.id === t.id ? res.trigger : x)));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update trigger");
    }
  };

  return (
    <div className="border-t border-border/60 px-3 py-2.5 space-y-2">
      <div className="text-[10px] uppercase tracking-wide text-text-muted/70">When</div>
      {triggers.length === 0 ? (
        <p className="text-xs text-text-muted/70">
          No triggers yet — this automation only runs when you press Run.
        </p>
      ) : (
        triggers.map((t) => {
          const meta = TRIGGER_META[t.type as TriggerType];
          const Icon = meta?.icon ?? Play;
          return (
            <div key={t.id} className="flex items-center gap-2 text-xs">
              <Icon className="w-3.5 h-3.5 text-text-muted shrink-0" />
              <span className="text-[10px] uppercase tracking-wide text-text-muted w-16 shrink-0">
                {meta?.label ?? t.type}
              </span>
              <span className="font-mono text-text-muted truncate flex-1">{triggerSummary(t)}</span>
              {t.lastFiredAt && (
                <span className="text-[10px] text-text-muted/60 shrink-0">
                  last {new Date(t.lastFiredAt).toLocaleString()}
                </span>
              )}
              <button
                onClick={() => handleToggle(t)}
                className="text-[10px] text-text-muted hover:text-text shrink-0"
              >
                {t.enabled ? "pause" : "enable"}
              </button>
              <button
                onClick={() => handleDelete(t.id)}
                className="p-1 rounded text-text-muted hover:text-error transition-colors shrink-0"
                title="Delete trigger"
                aria-label="Delete trigger"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          );
        })
      )}

      {showAdd ? (
        <AddTriggerForm
          onCancel={() => setShowAdd(false)}
          onSubmit={async (type, config) => {
            const res = await api.createLocalBlueprintTrigger(blueprintId, { type, config });
            onChange([...triggers, res.trigger]);
            setShowAdd(false);
            toast.success("Trigger added");
          }}
        />
      ) : (
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add trigger
        </button>
      )}
    </div>
  );
}

/** Trigger config editor. Returns the (type, config) pair on submit. */
function AddTriggerForm({
  initialType = "github",
  initialConfig,
  onCancel,
  onSubmit,
  submitLabel = "Add",
}: {
  initialType?: TriggerType;
  initialConfig?: Record<string, unknown>;
  onCancel: () => void;
  onSubmit: (type: TriggerType, config: Record<string, unknown>) => Promise<void>;
  submitLabel?: string;
}) {
  const [type, setType] = useState<TriggerType>(initialType);
  const [saving, setSaving] = useState(false);
  const c = initialConfig ?? {};

  // schedule / webhook / ticket
  const [cron, setCron] = useState(String(c.cronExpression ?? "0 9 * * 1-5"));
  const [path, setPath] = useState(
    String(c.path ?? `local-${Math.random().toString(36).slice(2, 10)}`),
  );
  const [source, setSource] = useState<(typeof TICKET_SOURCES)[number]>(
    (c.source as any) ?? "github",
  );
  const [labels, setLabels] = useState(Array.isArray(c.labels) ? c.labels.join(", ") : "");
  // github
  const [ghEvents, setGhEvents] = useState<string[]>(
    Array.isArray(c.events) && type === "github" ? (c.events as string[]) : ["review_requested"],
  );
  const [ghLogin, setGhLogin] = useState(String(c.login ?? ""));
  const [ghRepos, setGhRepos] = useState(Array.isArray(c.repos) ? c.repos.join(", ") : "");
  // slack
  const [channelId, setChannelId] = useState(String(c.channelId ?? ""));
  const [keyword, setKeyword] = useState(String(c.keyword ?? ""));
  const [mentionOnly, setMentionOnly] = useState(Boolean(c.mentionOnly));
  const [includeThreads, setIncludeThreads] = useState(Boolean(c.includeThreads));
  // linear
  const [lnEvents, setLnEvents] = useState<string[]>(
    Array.isArray(c.events) && type === "linear" ? (c.events as string[]) : ["assigned"],
  );
  const [lnUser, setLnUser] = useState(String(c.user ?? ""));
  const [lnTeams, setLnTeams] = useState(Array.isArray(c.teams) ? c.teams.join(", ") : "");

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const list = (s: string) =>
    s
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  const toggle = (arr: string[], v: string) =>
    arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v];

  const build = (): Record<string, unknown> | string => {
    switch (type) {
      case "schedule":
        if (cron.trim().split(/\s+/).length !== 5) return "Cron expression needs five fields";
        return { cronExpression: cron.trim() };
      case "webhook":
        if (!path.trim()) return "Webhook path is required";
        return { path: path.trim() };
      case "ticket": {
        const l = list(labels);
        return { source, ...(l.length ? { labels: l } : {}) };
      }
      case "github": {
        if (ghEvents.length === 0) return "Pick at least one GitHub event";
        const personal = ghEvents.some((e) => GITHUB_KINDS.find((k) => k.value === e)?.personal);
        if (personal && !ghLogin.trim()) return "Your GitHub username is required for those events";
        const r = list(ghRepos);
        return {
          events: ghEvents,
          ...(ghLogin.trim() ? { login: ghLogin.trim().replace(/^@/, "") } : {}),
          ...(r.length ? { repos: r } : {}),
        };
      }
      case "slack":
        if (!/^[A-Z][A-Z0-9]{5,}$/.test(channelId.trim())) {
          return "Slack channel id looks wrong — it's the C0123… id from the channel details";
        }
        return {
          channelId: channelId.trim(),
          ...(keyword.trim() ? { keyword: keyword.trim() } : {}),
          ...(mentionOnly ? { mentionOnly: true } : {}),
          ...(includeThreads ? { includeThreads: true } : {}),
        };
      case "linear": {
        if (lnEvents.length === 0) return "Pick at least one Linear event";
        const personal = lnEvents.some((e) => LINEAR_KINDS.find((k) => k.value === e)?.personal);
        if (personal && !lnUser.trim())
          return "Your Linear name or user id is required for those events";
        const l = list(labels);
        const t = list(lnTeams);
        return {
          events: lnEvents,
          ...(lnUser.trim() ? { user: lnUser.trim().replace(/^@/, "") } : {}),
          ...(l.length ? { labels: l } : {}),
          ...(t.length ? { teams: t } : {}),
        };
      }
    }
  };

  const submit = async () => {
    const built = build();
    if (typeof built === "string") {
      toast.error(built);
      return;
    }
    setSaving(true);
    try {
      await onSubmit(type, built);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save trigger");
    }
    setSaving(false);
  };

  const checkboxRow = (
    kinds: typeof GITHUB_KINDS,
    selected: string[],
    set: (next: string[]) => void,
  ) => (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {kinds.map((k) => (
        <label key={k.value} className="flex items-center gap-1.5 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={selected.includes(k.value)}
            onChange={() => set(toggle(selected, k.value))}
            className="accent-[#6d28d9]"
          />
          {k.label}
        </label>
      ))}
    </div>
  );

  return (
    <div className="rounded-md border border-border bg-bg p-2.5 space-y-2">
      <div className="flex items-center gap-1 flex-wrap">
        {(Object.keys(TRIGGER_META) as TriggerType[]).map((t) => {
          const Icon = TRIGGER_META[t].icon;
          return (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={cn(
                "inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11px] border transition-colors",
                type === t
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-text-muted hover:text-text",
              )}
            >
              <Icon className="w-3 h-3" />
              {TRIGGER_META[t].label}
            </button>
          );
        })}
      </div>

      {type === "schedule" && (
        <input
          type="text"
          value={cron}
          onChange={(e) => setCron(e.target.value)}
          placeholder="0 9 * * 1-5"
          className={cn(smallInput, "w-full font-mono")}
        />
      )}

      {type === "webhook" && (
        <>
          <input
            type="text"
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="my-hook-path"
            className={cn(smallInput, "w-full font-mono")}
          />
          {path.trim() && (
            <p className="text-[11px] text-text-muted font-mono break-all">
              POST {origin}/api/hooks/{path.trim()}
            </p>
          )}
        </>
      )}

      {type === "ticket" && (
        <div className="flex gap-2">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as any)}
            className={smallInput}
          >
            {TICKET_SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={labels}
            onChange={(e) => setLabels(e.target.value)}
            placeholder="labels, comma-separated (optional)"
            className={cn(smallInput, "flex-1")}
          />
        </div>
      )}

      {type === "github" && (
        <div className="space-y-2">
          {checkboxRow(GITHUB_KINDS, ghEvents, setGhEvents)}
          <div className="flex gap-2">
            <input
              type="text"
              value={ghLogin}
              onChange={(e) => setGhLogin(e.target.value)}
              placeholder="your GitHub username"
              className={cn(smallInput, "flex-1 font-mono")}
            />
            <input
              type="text"
              value={ghRepos}
              onChange={(e) => setGhRepos(e.target.value)}
              placeholder="owner/repo, owner/other (optional)"
              className={cn(smallInput, "flex-1 font-mono")}
            />
          </div>
          <p className="text-[11px] text-text-muted/80 leading-snug">
            Add a repo or org webhook pointing at{" "}
            <code className="font-mono break-all">{origin}/api/webhooks/github</code> with the
            server&apos;s <code className="font-mono">GITHUB_WEBHOOK_SECRET</code>, subscribed to
            Pull requests, Issues, Issue comments, Pull request reviews and review comments.
          </p>
        </div>
      )}

      {type === "slack" && (
        <div className="space-y-2">
          <div className="flex gap-2">
            <input
              type="text"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              placeholder="channel id, e.g. C0123ABCD"
              className={cn(smallInput, "flex-1 font-mono")}
            />
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="only when the message contains… (optional)"
              className={cn(smallInput, "flex-1")}
            />
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={mentionOnly}
                onChange={(e) => setMentionOnly(e.target.checked)}
                className="accent-[#6d28d9]"
              />
              Only when the app is @-mentioned
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={includeThreads}
                onChange={(e) => setIncludeThreads(e.target.checked)}
                className="accent-[#6d28d9]"
              />
              Include thread replies
            </label>
          </div>
          <p className="text-[11px] text-text-muted/80 leading-snug">
            In your Slack app, set the Event Subscriptions request URL to{" "}
            <code className="font-mono break-all">{origin}/api/webhooks/slack/events</code>,
            subscribe to <code className="font-mono">message.channels</code> (and{" "}
            <code className="font-mono">app_mention</code> for @-mentions), invite the app to the
            channel, and set <code className="font-mono">SLACK_SIGNING_SECRET</code> on the server.
          </p>
        </div>
      )}

      {type === "linear" && (
        <div className="space-y-2">
          {checkboxRow(LINEAR_KINDS, lnEvents, setLnEvents)}
          <div className="flex gap-2">
            <input
              type="text"
              value={lnUser}
              onChange={(e) => setLnUser(e.target.value)}
              placeholder="your Linear name, @handle, or user id"
              className={cn(smallInput, "flex-1")}
            />
            <input
              type="text"
              value={lnTeams}
              onChange={(e) => setLnTeams(e.target.value)}
              placeholder="team keys, e.g. ENG (optional)"
              className={cn(smallInput, "w-40 font-mono")}
            />
            <input
              type="text"
              value={labels}
              onChange={(e) => setLabels(e.target.value)}
              placeholder="labels (optional)"
              className={cn(smallInput, "w-40")}
            />
          </div>
          <p className="text-[11px] text-text-muted/80 leading-snug">
            In Linear → Settings → API → Webhooks, add{" "}
            <code className="font-mono break-all">{origin}/api/webhooks/linear</code> for Issues and
            Comments, and set <code className="font-mono">LINEAR_WEBHOOK_SECRET</code> on the server
            to the webhook&apos;s signing secret.
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={submit}
          disabled={saving}
          className="flex items-center gap-1 px-2.5 py-1 rounded bg-primary text-white text-[11px] font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {saving && <Loader2 className="w-3 h-3 animate-spin" />}
          {submitLabel}
        </button>
        <button
          onClick={onCancel}
          className="px-2.5 py-1 rounded border border-border text-[11px] text-text-muted hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Labelled row of the editor (hoisted so inputs keep focus across re-renders). */
function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[72px_1fr] items-start">
      <div className="text-[10px] uppercase tracking-wide text-text-muted/70 pt-2">{label}</div>
      <div className="space-y-2 min-w-0">{children}</div>
    </div>
  );
}

function AutomationEditor({
  hosts,
  initial,
  pendingTrigger,
  blueprintId,
  onCancel,
  onSaved,
}: {
  hosts: any[];
  initial: FormState;
  /** Create mode: a trigger to attach right after the automation is created. */
  pendingTrigger?: { type: TriggerType; config: Record<string, unknown> };
  blueprintId?: string;
  onCancel: () => void;
  onSaved: (blueprint: any, trigger?: any) => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const [trigger, setTrigger] = useState<
    { type: TriggerType; config: Record<string, unknown> } | null | undefined
  >(pendingTrigger);
  const [editingTrigger, setEditingTrigger] = useState(!!pendingTrigger);
  const [saving, setSaving] = useState(false);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const host = hosts.find((h) => h.id === form.hostId);
  const hintSource = trigger?.type ?? "github";
  const hints = useMemo(() => PARAM_HINTS[hintSource] ?? [], [hintSource]);

  const save = async () => {
    if (!form.name.trim() || !form.commandTemplate.trim()) {
      toast.error(form.agent ? "Name and prompt are required" : "Name and command are required");
      return;
    }
    if (form.locationKind === "dir" && !form.dir.trim()) {
      toast.error("Pick a directory");
      return;
    }
    if (form.locationKind === "repoUrl" && !form.repoUrl.trim()) {
      toast.error("Repo URL is required");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        hostId: form.hostId || null,
        dir: form.locationKind === "dir" ? form.dir.trim() : null,
        repoUrl: form.locationKind === "repoUrl" ? form.repoUrl.trim() : null,
        commandTemplate: form.commandTemplate.trim(),
        agent: form.agent || null,
        spawnMode: form.spawnMode,
        sessionMode: form.sessionMode,
      };
      let bp: any;
      if (blueprintId) {
        bp = (await api.updateLocalBlueprint(blueprintId, payload)).blueprint;
      } else {
        const create = {
          ...payload,
          description: payload.description ?? undefined,
          hostId: payload.hostId ?? undefined,
          dir: payload.dir ?? undefined,
          repoUrl: payload.repoUrl ?? undefined,
        };
        bp = (await api.createLocalBlueprint(create)).blueprint;
      }
      let created: any;
      if (!blueprintId && trigger) {
        try {
          created = (await api.createLocalBlueprintTrigger(bp.id, trigger)).trigger;
        } catch (err) {
          toast.error(
            `Automation saved, but the trigger wasn't: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      toast.success(blueprintId ? "Automation updated" : "Automation created");
      onSaved(bp, created);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save automation");
    }
    setSaving(false);
  };

  return (
    <div className="rounded-lg border border-primary/30 bg-bg-card p-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="block text-xs text-text-muted mb-1">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. PR review requested"
            className={input}
          />
        </div>
        <div>
          <label className="block text-xs text-text-muted mb-1">
            Notes <span className="text-text-muted/60">(optional)</span>
          </label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="what this is for"
            className={input}
          />
        </div>
      </div>

      <Section label="Who">
        <div className="flex flex-wrap gap-1">
          {AGENTS.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => set("agent", a)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs border transition-colors",
                form.agent === a
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border text-text-muted hover:text-text",
              )}
            >
              {AGENT_LABELS[a]}
            </button>
          ))}
          <button
            type="button"
            onClick={() => set("agent", "")}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs border transition-colors",
              form.agent === ""
                ? "border-primary/40 bg-primary/10 text-primary"
                : "border-border text-text-muted hover:text-text",
            )}
          >
            Shell command
          </button>
        </div>
      </Section>

      <Section label="What">
        <textarea
          value={form.commandTemplate}
          onChange={(e) => set("commandTemplate", e.target.value)}
          rows={form.agent ? 6 : 2}
          placeholder={
            form.agent
              ? "Review {{url}} and post your findings as a PR comment…"
              : "claude {{prompt}}"
          }
          className={cn(input, "font-mono resize-y")}
        />
        {hints.length > 0 && (
          <div className="flex flex-wrap gap-1 items-center">
            <span className="text-[10px] text-text-muted/70 mr-1">
              {TRIGGER_META[hintSource as TriggerType]?.label ?? hintSource} params:
            </span>
            {hints.map((h) => (
              <button
                key={h}
                type="button"
                onClick={() => set("commandTemplate", `${form.commandTemplate}{{${h}}}`)}
                className="px-1.5 py-0.5 rounded border border-border bg-bg text-[10px] font-mono text-text-muted hover:text-text"
                title="Append to the prompt"
              >
                {`{{${h}}}`}
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] text-text-muted/70">
          {form.agent
            ? "Rendered as the agent's prompt. Params are substituted as-is."
            : 'Runs as a shell command. Params are shell-quoted before substitution — write claude {{prompt}}, not claude "{{prompt}}".'}
        </p>
      </Section>

      <Section label="Where">
        <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <select
            value={form.hostId}
            onChange={(e) => {
              set("hostId", e.target.value);
              set("dir", "");
            }}
            className={input}
          >
            <option value="">Any online host</option>
            {hosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3 flex-wrap">
              {(
                [
                  ["event", "The event's repo"],
                  ["dir", "A directory"],
                  ["repoUrl", "A repo URL"],
                ] as Array<[FormState["locationKind"], string]>
              ).map(([k, label]) => (
                <label key={k} className="flex items-center gap-1.5 text-xs text-text-muted">
                  <input
                    type="radio"
                    name="automation-location"
                    checked={form.locationKind === k}
                    onChange={() => set("locationKind", k)}
                    className="accent-[#6d28d9]"
                  />
                  {label}
                </label>
              ))}
            </div>
            {form.locationKind === "event" && (
              <p className="text-[11px] text-text-muted/70">
                Uses the folder whose git remote matches the PR / issue&apos;s repo; otherwise the
                host&apos;s first folder.
              </p>
            )}
            {form.locationKind === "dir" &&
              (host && host.dirs?.length > 0 ? (
                <select
                  value={form.dir}
                  onChange={(e) => set("dir", e.target.value)}
                  className={cn(input, "font-mono")}
                >
                  <option value="">Pick a directory…</option>
                  {host.dirs.map((d: any) => (
                    <option key={d.path} value={d.path}>
                      {d.path}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={form.dir}
                  onChange={(e) => set("dir", e.target.value)}
                  placeholder="/absolute/path/on/the/host"
                  className={cn(input, "font-mono")}
                />
              ))}
            {form.locationKind === "repoUrl" && (
              <input
                type="text"
                value={form.repoUrl}
                onChange={(e) => set("repoUrl", e.target.value)}
                placeholder="https://github.com/owner/repo — matched against the host's folders"
                className={cn(input, "font-mono")}
              />
            )}
          </div>
        </div>
      </Section>

      <Section label="Then">
        {form.agent ? (
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                [
                  "interactive",
                  "Keep the session open",
                  "The agent halts at its prompt when the turn is done and waits in Needs you — come chat with it when you're ready.",
                ],
                [
                  "headless",
                  "Exit when done",
                  "Runs one turn and exits. The result lands in Needs you for review, and you can resume the session as a chat later.",
                ],
              ] as Array<[SessionMode, string, string]>
            ).map(([mode, title, blurb]) => (
              <button
                key={mode}
                type="button"
                onClick={() => set("sessionMode", mode)}
                className={cn(
                  "text-left rounded-lg border p-2.5 transition-colors",
                  form.sessionMode === mode
                    ? "border-primary/50 bg-primary/5"
                    : "border-border hover:border-primary/30",
                )}
              >
                <div className="text-xs font-medium">{title}</div>
                <p className="text-[11px] text-text-muted mt-0.5 leading-snug">{blurb}</p>
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[11px] text-text-muted/70">
            Shell commands exit when they finish; the result lands in Needs you.
          </p>
        )}
        <label className="flex items-center gap-2 text-xs text-text-muted">
          <input
            type="checkbox"
            checked={form.spawnMode === "hold"}
            onChange={(e) => set("spawnMode", e.target.checked ? "hold" : "auto")}
            className="accent-[#6d28d9]"
          />
          Don&apos;t start automatically — create the session and wait for me to press Start
        </label>
      </Section>

      {!blueprintId && (
        <Section label="When">
          {trigger && !editingTrigger ? (
            <div className="flex items-center gap-2 text-xs">
              {(() => {
                const Icon = TRIGGER_META[trigger.type].icon;
                return <Icon className="w-3.5 h-3.5 text-text-muted" />;
              })()}
              <span className="font-mono text-text-muted truncate flex-1">
                {TRIGGER_META[trigger.type].label}: {triggerSummary(trigger)}
              </span>
              <button
                type="button"
                onClick={() => setEditingTrigger(true)}
                className="text-[11px] text-text-muted hover:text-text"
              >
                edit
              </button>
              <button
                type="button"
                onClick={() => setTrigger(null)}
                className="text-[11px] text-text-muted hover:text-error"
              >
                remove
              </button>
            </div>
          ) : editingTrigger ? (
            <AddTriggerForm
              initialType={trigger?.type}
              initialConfig={trigger?.config}
              submitLabel="Use this trigger"
              onCancel={() => {
                setEditingTrigger(false);
                if (!trigger?.config || Object.keys(trigger.config).length === 0) setTrigger(null);
              }}
              onSubmit={async (type, config) => {
                setTrigger({ type, config });
                setEditingTrigger(false);
              }}
            />
          ) : (
            <button
              type="button"
              onClick={() => setEditingTrigger(true)}
              className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text transition-colors"
            >
              <Plus className="w-3 h-3" />
              Add a trigger (or run it by hand)
            </button>
          )}
        </Section>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary text-white text-xs font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
        >
          {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
          {blueprintId ? "Save changes" : "Create automation"}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-md border border-border text-xs text-text-muted hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
