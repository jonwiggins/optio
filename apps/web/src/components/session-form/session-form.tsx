"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { providerForAgentType } from "@optio/shared";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Clock,
  FolderOpen,
  GitBranch as GitBranchIcon,
  GitPullRequest,
  Github,
  Hash,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  Play,
  Sparkles,
  Terminal,
  Ticket,
  Webhook,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ModeCard } from "@/components/mode-card";
import { NumberInput } from "@/components/number-input";
import { AgentOptionsPicker } from "@/components/agent-options-picker";
import { RunLocationPicker } from "@/components/run-location-picker";
import { TriggerSelector, TriggerTypeButton, cronIsValid } from "@/components/trigger-selector";
import { GITHUB_KINDS, LINEAR_KINDS } from "@/components/local/automations-section";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import {
  EMPTY_DRAFT,
  PRESETS,
  TERMINAL,
  TRIGGER_PARAMS,
  WHEN_TYPES,
  describe,
  deriveKind,
  fullOptionsApply,
  isEventWhen,
  isLocal,
  missingFields,
  normalize,
  optionsFromRepo,
  runtimeLabel,
  runtimeOptions,
  slugify,
  thenOptions,
  whereOptions,
  type EventTriggerType,
  type SentenceField,
  type SessionDraft,
  type Then,
  type WhenType,
} from "./model";
import { createSession } from "./submit";

/**
 * The one creation form. Six groups in dependency order — When, Where, Who,
 * What, Exit conditions, Name — each narrowing the next, and a sentence up
 * top that says what you're about to make. There is no "type" to pick: the
 * row it becomes is derived from the answers (`deriveKind`).
 *
 * Built from the pieces the dedicated forms already use: the mode cards,
 * the run-location picker, the trigger selector, the agent options picker,
 * the number input.
 */

const INPUT =
  "w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors";
const INPUT_INNER = INPUT.replace("bg-bg-card", "bg-bg");

const FIELD_IDS: Record<SentenceField, string> = {
  checkout: "session-where",
  repo: "session-where",
  machine: "session-where",
  prompt: "session-prompt",
  cron: "session-when",
  webhook: "session-when",
};

const PRESET_ICONS: Record<string, ReactNode> = {
  pr: <GitPullRequest className="w-3.5 h-3.5" />,
  chat: <MessageSquare className="w-3.5 h-3.5" />,
  schedule: <Clock className="w-3.5 h-3.5" />,
  agent: <Bot className="w-3.5 h-3.5" />,
};

const WHEN_META: Record<WhenType, { label: string; icon: ReactNode }> = {
  manual: { label: "Now", icon: <Play className="w-3.5 h-3.5" /> },
  schedule: { label: "Schedule", icon: <Clock className="w-3.5 h-3.5" /> },
  webhook: { label: "Webhook", icon: <Webhook className="w-3.5 h-3.5" /> },
  ticket: { label: "Ticket", icon: <Ticket className="w-3.5 h-3.5" /> },
  github: { label: "GitHub", icon: <Github className="w-3.5 h-3.5" /> },
  slack: { label: "Slack", icon: <Hash className="w-3.5 h-3.5" /> },
  linear: { label: "Linear", icon: <Zap className="w-3.5 h-3.5" /> },
};

const DEFAULT_EVENT_CONFIG: Record<EventTriggerType, Record<string, unknown>> = {
  github: { events: ["review_requested", "mentioned"], login: "" },
  slack: { channelId: "", mentionOnly: false },
  linear: { events: ["assigned", "mentioned"], user: "" },
};

const THEN_CARDS: Record<
  Then,
  { icon: ReactNode; title: string; subtitle: string; description: string }
> = {
  exits: {
    icon: <LogOut className="w-5 h-5" />,
    title: "Exit when done",
    subtitle: "A one-shot run",
    description:
      "The agent does one turn of work and the session finishes. On a branch, it opens the PR first.",
  },
  "waits-for-me": {
    icon: <Terminal className="w-5 h-5" />,
    title: "Wait for me",
    subtitle: "An interactive session",
    description:
      "Stops at its prompt after each turn and lands in your “needs you” queue until you type.",
  },
  "waits-for-messages": {
    icon: <Bot className="w-5 h-5" />,
    title: "Persistent agent",
    subtitle: "Stays reachable",
    description:
      "Named and addressable. Keeps its memory between turns and wakes when a person or another agent messages it.",
  },
};

export function SessionForm() {
  const router = useRouter();
  const [draft, setDraftRaw] = useState<SessionDraft>(() =>
    normalize(PRESETS[0].apply(EMPTY_DRAFT)),
  );
  const [preset, setPreset] = useState<string | null>(PRESETS[0].id);
  const [submitting, setSubmitting] = useState(false);
  const [more, setMore] = useState(false);
  const [showDeps, setShowDeps] = useState(false);

  const [repos, setRepos] = useState<any[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
  const [existingTasks, setExistingTasks] = useState<any[]>([]);
  const [sessionCount, setSessionCount] = useState<number | null>(null);
  const { hosts } = useLocalHosts();
  const promptRef = useRef<HTMLTextAreaElement>(null);

  // On a machine the checkout's git remote is the repo (the picker reports it).
  const [localRepoUrl, setLocalRepoUrl] = useState<string | null>(null);

  const setDraft = useCallback(
    (patch: Partial<SessionDraft> | ((d: SessionDraft) => SessionDraft)) => {
      setDraftRaw((d) => normalize(typeof patch === "function" ? patch(d) : { ...d, ...patch }));
      setPreset(null);
    },
    [],
  );

  useEffect(() => {
    api
      .listRepos()
      .then((res) => setRepos(res.repos))
      .catch(() => {})
      .finally(() => setReposLoading(false));
    api
      .listTemplates()
      .then((res) => setTemplates(res.templates))
      .catch(() => {});
    api
      .listTasks({ limit: 100 })
      .then((res) => setExistingTasks(res.tasks))
      .catch(() => {});
    api
      .listTasksUnified({ type: "all", limit: 1 })
      .then((res) => setSessionCount((res as any).total ?? res.tasks.length))
      .catch(() => setSessionCount(null));
  }, []);

  // Pre-select the first repo once the list is known, like the Task form did.
  useEffect(() => {
    if (!draft.repoId && repos.length > 0) {
      const first = repos[0];
      setDraftRaw((d) =>
        d.repoId
          ? d
          : {
              ...d,
              repoId: first.id,
              repoUrl: first.repoUrl,
              repoBranch: first.defaultBranch ?? "main",
              agentOptions: optionsFromRepo(d.runtime, first),
            },
      );
    }
  }, [repos, draft.repoId]);

  // A pod Task starts from the repo's configured parameters for the picked
  // runtime, so the picker shows what will actually run.
  const seedKey = `${draft.runtime}|${draft.repoId}|${fullOptionsApply(draft)}`;
  useEffect(() => {
    if (!fullOptionsApply(draft)) return;
    const repo = repos.find((r: any) => r.id === draft.repoId);
    if (!repo) return;
    setDraftRaw((d) =>
      Object.keys(d.agentOptions).length
        ? d
        : { ...d, agentOptions: optionsFromRepo(d.runtime, repo) },
    );
  }, [seedKey, repos]);

  const local = isLocal(draft);
  const kind = deriveKind(draft);
  const effectiveRepoUrl = local ? (localRepoUrl ?? "") : draft.repoUrl;
  const repoRow = repos.find((r: any) => r.id === draft.repoId);
  const machine = hosts.find((h) => h.id === draft.location.localHostId);
  const sentenceCtx = { repoName: repoRow?.fullName ?? null, machineName: machine?.name ?? null };
  const sentence = useMemo(() => describe(draft, sentenceCtx), [draft, repoRow, machine]);
  const gaps = missingFields(draft, sentenceCtx);
  const wantsRepoUrl = draft.withRepo && draft.then !== "waits-for-messages";
  const canSubmit = !submitting && gaps.length === 0 && (!wantsRepoUrl || !!effectiveRepoUrl);
  const autoName = `Session ${(sessionCount ?? 0) + 1}`;
  const params = TRIGGER_PARAMS[draft.when];
  const isTerminal = draft.runtime === TERMINAL;

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    setDraftRaw((d) => normalize(p.apply(d)));
    setPreset(id);
  };

  const handleRepoChange = (repoId: string) => {
    const repo = repos.find((r: any) => r.id === repoId);
    if (!repo) return;
    setDraft((d) => ({
      ...d,
      repoId: repo.id,
      repoUrl: repo.repoUrl,
      repoBranch: repo.defaultBranch ?? "main",
      agentOptions: optionsFromRepo(d.runtime, repo),
    }));
  };

  const setWhen = (w: WhenType) => {
    setDraft((d) => {
      if (isEventWhen(w)) {
        return {
          ...d,
          when: w,
          trigger: { type: "manual" },
          event: d.event.type === w ? d.event : { type: w, config: DEFAULT_EVENT_CONFIG[w] },
        };
      }
      return { ...d, when: w };
    });
  };

  const setWhere = (runTarget: "cluster" | "local") => {
    // A pod defaults to one of your repos; a machine to the directory as it is.
    setDraft((d) => ({
      ...d,
      location: { ...d.location, runTarget },
      withRepo: runTarget === "cluster",
    }));
  };

  const insertParam = (name: string) => {
    const token = `{{${name}}}`;
    const el = promptRef.current;
    setDraft((d) => {
      if (!el) {
        const sep = d.prompt && !d.prompt.endsWith(" ") ? " " : "";
        return { ...d, prompt: `${d.prompt}${sep}${token}` };
      }
      const start = el.selectionStart ?? d.prompt.length;
      const end = el.selectionEnd ?? d.prompt.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
      return { ...d, prompt: d.prompt.slice(0, start) + token + d.prompt.slice(end) };
    });
  };

  const scrollTo = (field: SentenceField) => {
    document
      .getElementById(FIELD_IDS[field])
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    if (draft.when === "schedule" && !cronIsValid(draft.trigger.cronExpression)) {
      toast.error("Invalid cron expression", {
        description: "Expected five space-separated fields.",
      });
      return;
    }
    setSubmitting(true);
    try {
      const created = await createSession(draft, { repoUrl: effectiveRepoUrl, autoName });
      toast.success(created.toast);
      router.push(created.href);
    } catch (err) {
      toast.error("Couldn't create the session", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setSubmitting(false);
    }
  };

  const submitLabel =
    kind === "persistent-agent"
      ? "Create agent"
      : draft.when === "manual"
        ? draft.then === "exits"
          ? draft.withRepo
            ? "Start session (opens a PR)"
            : "Start session"
          : "Open session"
        : "Save session";

  const wheres = whereOptions(draft);
  const runtimes = runtimeOptions(draft);
  const thens = thenOptions(draft);
  const podDisabled = wheres.find((w) => w.value === "cluster")?.disabled;
  const disabledRuntimes = runtimes.filter((r) => r.disabled);

  return (
    <div className="p-6 max-w-3xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">New session</h1>
      <p className="text-sm text-text-muted mb-5">
        Everything Optio runs is a session. Say what starts it, where it runs, who drives it, what
        it does, and what happens when a turn ends.
      </p>

      {/* ── Presets ─────────────────────────────────────────────────────── */}
      <div className="mb-5">
        <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">
          Start from an example
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-1.5 p-1 rounded-lg bg-bg-card border border-border">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              title={p.hint}
              onClick={() => applyPreset(p.id)}
              className={cn(
                "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors",
                preset === p.id ? "bg-primary text-white" : "text-text-muted hover:text-text",
              )}
            >
              {PRESET_ICONS[p.id]}
              <span className="whitespace-nowrap">{p.label}</span>
            </button>
          ))}
        </div>
      </div>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* ── The sentence ────────────────────────────────────────────── */}
        <div
          className={cn(
            "flex items-start gap-2 px-3 py-2.5 rounded-md border text-sm leading-relaxed",
            gaps.length === 0
              ? "border-primary/20 bg-primary/5 text-primary"
              : "border-text-muted/20 bg-bg-card text-text",
          )}
        >
          <Sparkles className="w-3.5 h-3.5 shrink-0 mt-1" />
          <p>
            {sentence.map((part, i) => {
              const punct = "text" in part && /^[,.]/.test(part.text);
              const sep = i > 0 && !punct ? " " : "";
              return "missing" in part ? (
                <span key={i}>
                  {sep}
                  <button
                    type="button"
                    onClick={() => scrollTo(part.field)}
                    className="px-1.5 rounded border border-dashed border-warning text-warning hover:bg-warning/10"
                  >
                    {part.missing}
                  </button>
                </span>
              ) : (
                <span key={i}>
                  {sep}
                  {part.text}
                </span>
              );
            })}
          </p>
        </div>

        {/* ── When ────────────────────────────────────────────────────── */}
        <Section label="When" hint="What starts it?" id="session-when">
          <TriggerSelector
            value={draft.trigger}
            onChange={(trigger) => setDraft({ trigger, when: trigger.type })}
            manualLabel="Now"
            extraActive={isEventWhen(draft.when)}
            extra={WHEN_TYPES.filter(isEventWhen).map((w) => (
              <TriggerTypeButton
                key={w}
                icon={WHEN_META[w].icon}
                label={WHEN_META[w].label}
                active={draft.when === w}
                onClick={() => setWhen(w)}
              />
            ))}
          />
          {isEventWhen(draft.when) && (
            <EventConfig
              type={draft.when}
              config={draft.event.config}
              onChange={(config) =>
                setDraft((d) => ({ ...d, event: { type: d.when as EventTriggerType, config } }))
              }
            />
          )}
        </Section>

        {/* ── Where ───────────────────────────────────────────────────── */}
        <Section label="Where" id="session-where">
          <div className="space-y-3">
            <RunLocationPicker
              value={draft.location}
              onChange={(location) =>
                location.runTarget !== draft.location.runTarget
                  ? setWhere(location.runTarget)
                  : setDraft({ location })
              }
              kind={draft.withRepo ? "task" : "job"}
              agentType={draft.runtime || undefined}
              onRepoUrlChange={setLocalRepoUrl}
              hideSessionMode
              clusterDisabled={podDisabled}
            />

            <div className="p-4 rounded-lg border border-border bg-bg-card/60 space-y-3">
              {local ? (
                <>
                  <Segmented
                    value={draft.withRepo ? "branch" : "current"}
                    onChange={(v) => setDraft({ withRepo: v === "branch" })}
                    options={[
                      {
                        value: "current",
                        label: "Current directory",
                        icon: <FolderOpen className="w-3 h-3" />,
                      },
                      {
                        value: "branch",
                        label: "New branch",
                        icon: <GitBranchIcon className="w-3 h-3" />,
                      },
                    ]}
                  />
                  {draft.withRepo ? (
                    <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] sm:items-end gap-3">
                      <div className="sm:w-56">
                        <label className="block text-sm text-text-muted mb-1.5">Base branch</label>
                        <div className="flex items-center gap-2">
                          <GitBranchIcon className="w-3.5 h-3.5 text-text-muted" />
                          <input
                            type="text"
                            value={draft.repoBranch}
                            onChange={(e) => setDraft({ repoBranch: e.target.value })}
                            className={INPUT_INNER}
                          />
                        </div>
                      </div>
                      <p className="text-[11px] text-text-muted/80 sm:pb-2.5">
                        The agent branches off this in the checkout and opens a PR against it.
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-text-muted/80">
                      Works in the directory as it is, on whatever branch is checked out. Nothing is
                      pushed unless you or the agent do it.
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Segmented
                    value={draft.withRepo ? "repo" : "none"}
                    onChange={(v) => setDraft({ withRepo: v === "repo" })}
                    options={[
                      {
                        value: "repo",
                        label: "A repository",
                        icon: <GitPullRequest className="w-3 h-3" />,
                      },
                      { value: "none", label: "No repo", icon: <Terminal className="w-3 h-3" /> },
                    ]}
                  />
                  {draft.withRepo ? (
                    reposLoading ? (
                      <div className="flex items-center gap-2 text-text-muted text-sm py-1">
                        <Loader2 className="w-4 h-4 animate-spin" /> Loading repos...
                      </div>
                    ) : repos.length > 0 ? (
                      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
                        <div>
                          <label className="block text-sm text-text-muted mb-1.5">Repository</label>
                          <select
                            value={draft.repoId}
                            onChange={(e) => handleRepoChange(e.target.value)}
                            className={INPUT_INNER}
                          >
                            {repos.map((repo: any) => (
                              <option key={repo.id} value={repo.id}>
                                {repo.fullName} ({repo.defaultBranch})
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="sm:w-40">
                          <label className="block text-sm text-text-muted mb-1.5">Branch</label>
                          <div className="flex items-center gap-2">
                            <GitBranchIcon className="w-3.5 h-3.5 text-text-muted" />
                            <input
                              type="text"
                              value={draft.repoBranch}
                              onChange={(e) => setDraft({ repoBranch: e.target.value })}
                              className={INPUT_INNER}
                            />
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-sm text-text-muted py-1">
                        No repos configured.{" "}
                        <a href="/repos" className="text-primary hover:underline">
                          Add a repo
                        </a>{" "}
                        first, or pick My machine above.
                      </div>
                    )
                  ) : (
                    <p className="text-[11px] text-text-muted/80">
                      No checkout — results are logs and side effects through Connections.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </Section>

        {/* ── Who ─────────────────────────────────────────────────────── */}
        <Section label="Who" hint="A terminal, or an agent?" id="session-who">
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 p-1 rounded-lg bg-bg-card border border-border">
              {runtimes.map((r) => (
                <button
                  key={r.value || "terminal"}
                  type="button"
                  title={
                    r.disabled
                      ? `${r.value === TERMINAL ? "Terminal" : runtimeLabel(r.value)} ${r.disabled}`
                      : undefined
                  }
                  disabled={!!r.disabled}
                  onClick={() => setDraft({ runtime: r.value, agentOptions: {} })}
                  className={cn(
                    "flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm transition-colors whitespace-nowrap",
                    draft.runtime === r.value
                      ? "bg-primary text-white"
                      : r.disabled
                        ? "text-text-muted/40 cursor-not-allowed"
                        : "text-text-muted hover:text-text",
                  )}
                >
                  {r.value === TERMINAL ? (
                    <Terminal className="w-3.5 h-3.5" />
                  ) : (
                    <Bot className="w-3.5 h-3.5" />
                  )}
                  {r.value === TERMINAL ? "Terminal" : runtimeLabel(r.value)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-text-muted/80">
              {isTerminal
                ? "Just you at a shell prompt — no agent, no prompt."
                : local
                  ? "Uses the CLI and login already on the machine."
                  : "Runs with the server's agent credentials."}
              {disabledRuntimes.length > 0 &&
                ` ${disabledRuntimes
                  .map((r) => (r.value === TERMINAL ? "Terminal" : runtimeLabel(r.value)))
                  .join(", ")} — ${disabledRuntimes[0].disabled}.`}
            </p>

            {!isTerminal && (
              <div className="p-4 rounded-lg border border-border bg-bg-card/60">
                <AgentOptionsPicker
                  key={draft.runtime}
                  provider={providerForAgentType(draft.runtime)}
                  values={draft.agentOptions}
                  onChange={(agentOptions) => setDraft({ agentOptions })}
                  modelOnly={!fullOptionsApply(draft)}
                  hideRefresh
                />
                <p className="text-[11px] text-text-muted/80 mt-3">
                  {local
                    ? "On your machine the CLI takes a model; its other settings come from the machine's own config."
                    : fullOptionsApply(draft)
                      ? "Starts from the repo's configured parameters; changes apply to this session only."
                      : "Blank means the runtime's default."}
                </p>
              </div>
            )}
          </div>
        </Section>

        {/* ── What ────────────────────────────────────────────────────── */}
        {!isTerminal && (
          <Section label="What" id="session-prompt">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-sm text-text-muted">
                  {draft.then === "waits-for-messages" ? "Initial prompt" : "Prompt"}
                  {kind === "local-terminal" && (
                    <span className="text-text-muted/60"> (optional)</span>
                  )}
                </label>
                {templates.length > 0 && (
                  <select
                    value=""
                    onChange={(e) => {
                      const t = templates.find((x) => x.id === e.target.value);
                      if (t) setDraft({ prompt: t.template ?? "" });
                    }}
                    className="px-2 py-1 rounded-md bg-bg-card border border-border text-xs text-text-muted"
                  >
                    <option value="">Use a saved prompt…</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <textarea
                ref={promptRef}
                rows={6}
                value={draft.prompt}
                onChange={(e) => setDraft({ prompt: e.target.value })}
                placeholder={
                  draft.when === "ticket" || draft.when === "linear"
                    ? "{{ticketUrl}}, please triage this ticket."
                    : draft.when === "github"
                      ? "Review {{url}} and leave comments on anything risky."
                      : draft.then === "waits-for-messages"
                        ? "Who this agent is and what it should do on its first turn."
                        : draft.withRepo
                          ? "Describe the change. Be specific about files to modify and expected behavior."
                          : "Describe what the agent should do. Reference Connections for external systems."
                }
                className={cn(INPUT, "resize-y font-mono")}
              />
              {draft.when !== "manual" && (
                <div className="mt-2">
                  <p className="text-xs text-text-muted/60 mb-1.5">
                    {params.length > 0 ? (
                      <>From the {WHEN_META[draft.when].label} trigger — click to insert:</>
                    ) : draft.when === "webhook" ? (
                      <>
                        Any top-level field of the POSTed JSON is available as{" "}
                        <code className="font-mono">{"{{field}}"}</code>.
                      </>
                    ) : (
                      "A schedule carries no parameters."
                    )}
                  </p>
                  {params.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {params.map((name) => (
                        <button
                          key={name}
                          type="button"
                          onClick={() => insertParam(name)}
                          className="px-1.5 py-0.5 rounded bg-bg-card border border-border font-mono text-[11px] text-text-muted hover:text-text hover:border-primary/50 transition-colors"
                        >
                          {`{{${name}}}`}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </Section>
        )}

        {/* ── Exit conditions ─────────────────────────────────────────── */}
        <Section label="Exit conditions" hint="What happens when a turn ends?">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {thens.map((c) => (
              <ModeCard
                key={c.value}
                active={draft.then === c.value}
                onClick={() => setDraft({ then: c.value })}
                icon={THEN_CARDS[c.value].icon}
                title={THEN_CARDS[c.value].title}
                subtitle={THEN_CARDS[c.value].subtitle}
                description={THEN_CARDS[c.value].description}
                disabled={!!c.disabled}
                disabledHint={c.disabled}
              />
            ))}
          </div>

          {draft.then === "waits-for-messages" && (
            <div className="mt-3 p-4 rounded-lg border border-border bg-bg-card/60 space-y-3">
              <div>
                <label className="block text-sm text-text-muted mb-1.5">Pod lifecycle</label>
                <Segmented
                  value={draft.agent.podLifecycle}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, agent: { ...d.agent, podLifecycle: v } }))
                  }
                  options={[
                    { value: "sticky", label: "Sticky" },
                    { value: "always-on", label: "Always on" },
                    { value: "on-demand", label: "On demand" },
                  ]}
                />
                <p className="text-[11px] text-text-muted/80 mt-1.5">
                  {draft.agent.podLifecycle === "sticky"
                    ? "The pod stays warm for a while after each turn, then goes away until the next wake."
                    : draft.agent.podLifecycle === "always-on"
                      ? "The pod never goes away — fastest wake, highest cost."
                      : "A fresh pod for every turn — slowest wake, nothing idle."}
                </p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm text-text-muted mb-1.5">
                    System prompt <span className="text-text-muted/60">(optional)</span>
                  </label>
                  <textarea
                    rows={3}
                    value={draft.agent.systemPrompt}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        agent: { ...d.agent, systemPrompt: e.target.value },
                      }))
                    }
                    className={cn(INPUT_INNER, "resize-y")}
                  />
                </div>
                <div>
                  <label className="block text-sm text-text-muted mb-1.5">
                    Operator manual{" "}
                    <span className="text-text-muted/60">(agents.md, optional)</span>
                  </label>
                  <textarea
                    rows={3}
                    value={draft.agent.agentsMd}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, agent: { ...d.agent, agentsMd: e.target.value } }))
                    }
                    placeholder="Blank = Optio's standard manual (messaging other agents, reading the inbox, finishing a turn)."
                    className={cn(INPUT_INNER, "font-mono resize-y")}
                  />
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* ── Name ────────────────────────────────────────────────────── */}
        <Section label="Name">
          <div className="space-y-3">
            <div
              className={cn("grid gap-3", draft.then === "waits-for-messages" && "sm:grid-cols-2")}
            >
              <div>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => setDraft({ name: e.target.value })}
                  placeholder={autoName}
                  className={INPUT}
                />
                <p className="text-xs text-text-muted/60 mt-1">
                  {draft.name.trim()
                    ? kind === "repo-task" || kind === "repo-blueprint"
                      ? "Also the title of the task that opens the PR."
                      : " "
                    : `Leave blank to call it “${autoName}”.`}
                </p>
              </div>
              {draft.then === "waits-for-messages" && (
                <div>
                  <input
                    type="text"
                    value={draft.agent.slug}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        agent: { ...d.agent, slug: slugify(e.target.value) },
                      }))
                    }
                    placeholder={slugify(draft.name.trim() || autoName)}
                    className={cn(INPUT, "font-mono")}
                  />
                  <p className="text-xs text-text-muted/60 mt-1">
                    Address — how other agents message it.
                  </p>
                </div>
              )}
            </div>

            <Disclosure open={more} onToggle={() => setMore(!more)} label="More">
              <div className="space-y-4">
                <div>
                  <label className="block text-sm text-text-muted mb-1.5">
                    Description <span className="text-text-muted/60">(optional)</span>
                  </label>
                  <input
                    type="text"
                    value={draft.description}
                    onChange={(e) => setDraft({ description: e.target.value })}
                    placeholder="Why does this session exist? Who asked for it?"
                    className={INPUT}
                  />
                </div>
                {draft.then === "exits" && (
                  <div className="flex flex-wrap gap-6">
                    {draft.withRepo && (
                      <div>
                        <label className="block text-sm text-text-muted mb-1.5">Priority</label>
                        <NumberInput
                          min={1}
                          max={1000}
                          value={draft.priority}
                          onChange={(v) => setDraft({ priority: v })}
                          fallback={100}
                          className="w-24 px-3 py-2 rounded-lg bg-bg-card border border-border text-sm"
                        />
                        <p className="text-xs text-text-muted/60 mt-1">
                          Lower = sooner. Default 100.
                        </p>
                      </div>
                    )}
                    <div>
                      <label className="block text-sm text-text-muted mb-1.5">Max retries</label>
                      <NumberInput
                        min={0}
                        max={10}
                        value={draft.maxRetries}
                        onChange={(v) => setDraft({ maxRetries: v })}
                        fallback={3}
                        className="w-24 px-3 py-2 rounded-lg bg-bg-card border border-border text-sm"
                      />
                    </div>
                  </div>
                )}
                {kind === "repo-task" && (
                  <div>
                    <button
                      type="button"
                      onClick={() => setShowDeps(!showDeps)}
                      className="flex items-center gap-1.5 text-sm text-text-muted hover:text-text transition-colors"
                    >
                      <Link2 className="w-3.5 h-3.5" />
                      Dependencies {draft.dependsOn.length > 0 && `(${draft.dependsOn.length})`}
                    </button>
                    {showDeps && (
                      <div className="mt-2 p-3 rounded-lg bg-bg border border-border">
                        <p className="text-xs text-text-muted/60 mb-2">
                          Wait for these sessions to complete first.
                        </p>
                        {existingTasks.filter((t) => !["completed", "cancelled"].includes(t.state))
                          .length === 0 ? (
                          <p className="text-xs text-text-muted">Nothing to wait on.</p>
                        ) : (
                          <div className="max-h-40 overflow-y-auto space-y-1">
                            {existingTasks
                              .filter((t) => !["completed", "cancelled"].includes(t.state))
                              .map((t) => (
                                <label
                                  key={t.id}
                                  className="flex items-center gap-2 text-xs py-0.5 cursor-pointer hover:bg-bg-hover rounded px-1"
                                >
                                  <input
                                    type="checkbox"
                                    checked={draft.dependsOn.includes(t.id)}
                                    onChange={(e) =>
                                      setDraft((d) => ({
                                        ...d,
                                        dependsOn: e.target.checked
                                          ? [...d.dependsOn, t.id]
                                          : d.dependsOn.filter((id) => id !== t.id),
                                      }))
                                    }
                                  />
                                  <span className="truncate flex-1">{t.title}</span>
                                  <span className="text-text-muted shrink-0">{t.state}</span>
                                </label>
                              ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </Disclosure>
          </div>
        </Section>

        {/* ── Submit ──────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between pt-2 border-t border-border">
          <p className="text-xs text-text-muted/60">
            {gaps.length === 0 ? "Ready." : `Still needed: ${[...new Set(gaps)].join(", ")}.`}
          </p>
          <button
            type="submit"
            disabled={!canSubmit}
            className="flex items-center gap-2 px-6 py-2.5 rounded-md bg-primary text-white text-sm font-medium hover:bg-primary-hover transition-colors disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : draft.when !== "manual" ? (
              <Clock className="w-4 h-4" />
            ) : draft.then === "waits-for-messages" ? (
              <Bot className="w-4 h-4" />
            ) : draft.then === "waits-for-me" ? (
              <Terminal className="w-4 h-4" />
            ) : draft.withRepo ? (
              <GitPullRequest className="w-4 h-4" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {submitting ? "Creating..." : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function Section({
  label,
  hint,
  id,
  children,
}: {
  label: string;
  hint?: string;
  id?: string;
  children: ReactNode;
}) {
  return (
    <div id={id}>
      <div className="flex items-baseline gap-2 mb-2">
        <div className="text-xs uppercase tracking-wider text-text-muted/60">{label}</div>
        {hint && <span className="text-xs text-text-muted/60">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/** The small pill toggle the Task form and picker use for either/or choices. */
function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: Array<{ value: T; label: string; icon?: ReactNode }>;
}) {
  return (
    <div className="flex gap-1.5 p-1 rounded-lg bg-bg border border-border w-fit">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors",
            value === o.value ? "bg-primary text-white" : "text-text-muted hover:text-text",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Disclosure({
  open,
  onToggle,
  label,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-1 text-xs text-text-muted hover:text-text transition-colors"
      >
        {open ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        {label}
      </button>
      {open && <div className="mt-3">{children}</div>}
    </div>
  );
}

/**
 * The event-trigger config for a Local automation, in the shape the
 * `/api/local/blueprints/:id/triggers` route stores (mirrors the editor in
 * `local/automations-section.tsx`, trimmed to the fields that matter here).
 */
function EventConfig({
  type,
  config,
  onChange,
}: {
  type: EventTriggerType;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const events = Array.isArray(config.events) ? (config.events as string[]) : [];
  const toggleEvent = (v: string) =>
    onChange({
      ...config,
      events: events.includes(v) ? events.filter((e) => e !== v) : [...events, v],
    });
  const kinds = type === "github" ? GITHUB_KINDS : type === "linear" ? LINEAR_KINDS : [];
  const personal = kinds.some((k) => k.personal && events.includes(k.value));

  return (
    <div className="mt-3 p-3 rounded-lg bg-bg-card border border-border space-y-3">
      {type === "slack" ? (
        <>
          <div>
            <label className="block text-xs text-text-muted mb-1">Channel id</label>
            <input
              type="text"
              value={String(config.channelId ?? "")}
              onChange={(e) => onChange({ ...config, channelId: e.target.value.trim() })}
              placeholder="C0123ABCD"
              className={cn(INPUT_INNER, "font-mono")}
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-text-muted">
            <input
              type="checkbox"
              checked={!!config.mentionOnly}
              onChange={(e) => onChange({ ...config, mentionOnly: e.target.checked })}
            />
            Only when the bot is @-mentioned
          </label>
        </>
      ) : (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {kinds.map((k) => (
              <label key={k.value} className="flex items-center gap-1.5 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={events.includes(k.value)}
                  onChange={() => toggleEvent(k.value)}
                />
                {k.label}
              </label>
            ))}
          </div>
          {personal && (
            <div>
              <label className="block text-xs text-text-muted mb-1">
                {type === "github" ? "Your GitHub username" : "Your Linear name or user id"}
              </label>
              <input
                type="text"
                value={String((type === "github" ? config.login : config.user) ?? "")}
                onChange={(e) =>
                  onChange({
                    ...config,
                    [type === "github" ? "login" : "user"]: e.target.value.replace(/^@/, ""),
                  })
                }
                className={INPUT_INNER}
              />
            </div>
          )}
        </>
      )}
      <p className="text-[11px] text-text-muted/80">
        Event triggers run sessions on your machine. Each firing opens one in the chosen directory
        with the event's fields available as {"{{param}}"}s.
      </p>
    </div>
  );
}
