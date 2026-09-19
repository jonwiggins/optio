"use client";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Clock,
  GitBranch as GitBranchIcon,
  GitPullRequest,
  Github,
  Hash,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  Server,
  Sparkles,
  Terminal,
  UserRound,
  Zap,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ModeCard } from "@/components/mode-card";
import { NumberInput } from "@/components/number-input";
import { RunLocationPicker } from "@/components/run-location-picker";
import { TriggerSelector, TriggerTypeButton, cronIsValid } from "@/components/trigger-selector";
import { GITHUB_KINDS, LINEAR_KINDS } from "@/components/local/automations-section";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import {
  EMPTY_DRAFT,
  PRESETS,
  SHELL,
  describe,
  deriveKind,
  isEventWhen,
  isLocal,
  missingFields,
  needsRepo,
  normalize,
  runtimeOptions,
  whenOptions,
  type EventTriggerType,
  type SentenceField,
  type SessionDraft,
  type Then,
  type WhenType,
} from "./model";
import { createSession } from "./submit";

/**
 * The one creation form. Five attribute groups in dependency order — Then,
 * Where, Who, What, When — each narrowing the next, and a sentence at the
 * top that says what you're about to make. There is no "type" to pick: the
 * row it becomes is derived from the five answers (see `deriveKind`).
 *
 * The groups reuse the pieces the dedicated forms were built from: the mode
 * cards, the run-location picker, the trigger selector, the number input.
 */

const INPUT =
  "w-full px-3 py-2 rounded-lg bg-bg-card border border-border text-sm focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-colors";
const INPUT_INNER = INPUT.replace("bg-bg-card", "bg-bg");

const FIELD_IDS: Record<SentenceField, string> = {
  checkout: "session-where",
  repo: "session-where",
  machine: "session-where",
  title: "session-title",
  prompt: "session-prompt",
  slug: "session-slug",
  cron: "session-when",
  webhook: "session-when",
};

const THEN_CARDS: Array<{
  value: Then;
  icon: ReactNode;
  title: string;
  subtitle: string;
  description: string;
}> = [
  {
    value: "exits",
    icon: <LogOut className="w-5 h-5" />,
    title: "Exits when done",
    subtitle: "A one-shot run",
    description:
      "The agent does one turn of work and the session finishes. With a repo it opens a PR first.",
  },
  {
    value: "waits-for-me",
    icon: <Terminal className="w-5 h-5" />,
    title: "Waits for me",
    subtitle: "An interactive terminal",
    description:
      "The agent stops at its prompt after each turn and lands in your “needs you” queue until you type.",
  },
  {
    value: "waits-for-messages",
    icon: <Bot className="w-5 h-5" />,
    title: "Waits for messages",
    subtitle: "A persistent agent",
    description:
      "Named and addressable. Keeps its memory between turns and wakes when a person or another agent messages it.",
  },
];

const PRESET_ICONS: Record<string, ReactNode> = {
  pr: <GitPullRequest className="w-3.5 h-3.5" />,
  chat: <MessageSquare className="w-3.5 h-3.5" />,
  schedule: <Clock className="w-3.5 h-3.5" />,
  agent: <Bot className="w-3.5 h-3.5" />,
};

const EVENT_META: Record<EventTriggerType, { label: string; icon: ReactNode }> = {
  github: { label: "GitHub", icon: <Github className="w-3.5 h-3.5" /> },
  slack: { label: "Slack", icon: <Hash className="w-3.5 h-3.5" /> },
  linear: { label: "Linear", icon: <Zap className="w-3.5 h-3.5" /> },
};

const DEFAULT_EVENT_CONFIG: Record<EventTriggerType, Record<string, unknown>> = {
  github: { events: ["review_requested", "mentioned"], login: "" },
  slack: { channelId: "", mentionOnly: false },
  linear: { events: ["assigned", "mentioned"], user: "" },
};

export function SessionForm() {
  const router = useRouter();
  const [draft, setDraftRaw] = useState<SessionDraft>(() => PRESETS[0].apply(EMPTY_DRAFT));
  const [preset, setPreset] = useState<string | null>(PRESETS[0].id);
  const [submitting, setSubmitting] = useState(false);
  const [moreWho, setMoreWho] = useState(false);
  const [moreWhat, setMoreWhat] = useState(false);
  const [showDeps, setShowDeps] = useState(false);

  const [repos, setRepos] = useState<any[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
  const [existingTasks, setExistingTasks] = useState<any[]>([]);
  const { hosts } = useLocalHosts();

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
            },
      );
    }
  }, [repos, draft.repoId]);

  const local = isLocal(draft);
  const kind = deriveKind(draft);
  const effectiveRepoUrl = local ? (localRepoUrl ?? "") : draft.repoUrl;
  const repoRow = repos.find((r: any) => r.id === draft.repoId);
  const machine = hosts.find((h) => h.id === draft.location.localHostId);
  const sentenceCtx = { repoName: repoRow?.fullName ?? null, machineName: machine?.name ?? null };
  const sentence = useMemo(() => describe(draft, sentenceCtx), [draft, repoRow, machine]);
  const gaps = missingFields(draft, sentenceCtx);
  const wantsRepoUrl = local ? draft.withRepo : needsRepo(draft);
  const canSubmit = !submitting && gaps.length === 0 && (!wantsRepoUrl || !!effectiveRepoUrl);

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
      runtime: repo.defaultAgentType ?? d.runtime,
    }));
  };

  const setWhen = (w: WhenType) => {
    if (isEventWhen(w)) {
      setDraft((d) => ({
        ...d,
        when: w,
        trigger: { type: "manual" },
        event: d.event.type === w ? d.event : { type: w, config: DEFAULT_EVENT_CONFIG[w] },
      }));
    } else {
      setDraft((d) => ({ ...d, when: w }));
    }
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
      const created = await createSession(draft, effectiveRepoUrl);
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

  const runtimes = runtimeOptions(draft);
  const whens = whenOptions(draft);
  const showRepoToggle =
    draft.then !== "waits-for-messages" && !(draft.then === "waits-for-me" && !local);

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <h1 className="text-2xl font-semibold tracking-tight mb-2">New session</h1>
      <p className="text-sm text-text-muted mb-5">
        Everything Optio runs is a session. Say what happens when a turn ends, where it runs, who
        drives it, what it does, and what starts it.
      </p>

      {/* ── Presets ─────────────────────────────────────────────────────── */}
      <div className="mb-5">
        <div className="text-xs uppercase tracking-wider text-text-muted/60 mb-2">Start from</div>
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
              const sep = i > 0 && !("text" in part && part.text === ".") ? " " : "";
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

        {/* ── Then ────────────────────────────────────────────────────── */}
        <Section label="Then" hint="What happens when a turn ends?">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {THEN_CARDS.map((c) => (
              <ModeCard
                key={c.value}
                active={draft.then === c.value}
                onClick={() => setDraft({ then: c.value })}
                icon={c.icon}
                title={c.title}
                subtitle={c.subtitle}
                description={c.description}
              />
            ))}
          </div>
        </Section>

        {/* ── Where ───────────────────────────────────────────────────── */}
        <Section label="Where" id="session-where">
          <div className="space-y-3">
            {draft.then === "waits-for-messages" ? (
              <div className="flex items-start gap-2 p-3 rounded-lg border border-border bg-bg-card text-xs text-text-muted">
                <Server className="w-4 h-4 shrink-0 text-primary" />
                <span>
                  Persistent agents run in an Optio pod so they can stay reachable between turns.
                  Pick the pod lifecycle under <span className="text-text">Who</span>.
                </span>
              </div>
            ) : (
              <RunLocationPicker
                value={draft.location}
                onChange={(location) => setDraft({ location })}
                kind={draft.withRepo ? "task" : "job"}
                agentType={draft.runtime || undefined}
                onRepoUrlChange={setLocalRepoUrl}
                hideSessionMode
              />
            )}

            {showRepoToggle && (
              <div className="p-4 rounded-lg border border-border bg-bg-card/60 space-y-3">
                <div className="flex gap-1.5 p-1 rounded-lg bg-bg border border-border w-fit">
                  {(
                    [
                      [true, GitPullRequest, local ? "A git checkout" : "With a repo"],
                      [false, Terminal, local ? "Any directory" : "No repo"],
                    ] as Array<[boolean, typeof Terminal, string]>
                  ).map(([v, Icon, label]) => (
                    <button
                      key={String(v)}
                      type="button"
                      onClick={() => setDraft({ withRepo: v })}
                      className={cn(
                        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs transition-colors",
                        draft.withRepo === v
                          ? "bg-primary text-white"
                          : "text-text-muted hover:text-text",
                      )}
                    >
                      <Icon className="w-3 h-3" />
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-text-muted/80">
                  {draft.then === "exits"
                    ? draft.withRepo
                      ? "The agent works on a branch and opens a pull request when it's done."
                      : "The agent runs with no checkout — results are logs and side effects through Connections."
                    : draft.withRepo
                      ? "The terminal opens inside a git checkout."
                      : "The terminal opens in a plain directory."}
                </p>

                {!local && draft.withRepo && (
                  <>
                    {reposLoading ? (
                      <div className="flex items-center gap-2 text-text-muted text-sm py-2">
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
                        {draft.then === "exits" && (
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
                        )}
                      </div>
                    ) : (
                      <div className="text-sm text-text-muted py-1">
                        No repos configured.{" "}
                        <a href="/repos" className="text-primary hover:underline">
                          Add a repo
                        </a>{" "}
                        first, or pick My machine above.
                      </div>
                    )}
                  </>
                )}

                {local && draft.withRepo && draft.then === "exits" && (
                  <div className="sm:w-60">
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
                    <p className="text-xs text-text-muted/60 mt-1">
                      The agent branches off this in your checkout and opens the PR against it.
                    </p>
                  </div>
                )}
              </div>
            )}

            {draft.then === "waits-for-me" && !local && (
              <div className="p-4 rounded-lg border border-border bg-bg-card/60">
                {reposLoading ? (
                  <div className="flex items-center gap-2 text-text-muted text-sm py-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading repos...
                  </div>
                ) : repos.length > 0 ? (
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
                    <p className="text-xs text-text-muted/60 mt-1">
                      A pod terminal is always attached to a repo checkout.
                    </p>
                  </div>
                ) : (
                  <div className="text-sm text-text-muted py-1">
                    No repos configured.{" "}
                    <a href="/repos" className="text-primary hover:underline">
                      Add a repo
                    </a>{" "}
                    first, or open the terminal on your machine instead.
                  </div>
                )}
              </div>
            )}
          </div>
        </Section>

        {/* ── Who ─────────────────────────────────────────────────────── */}
        <Section label="Who" id="session-who">
          <div className="space-y-3">
            <div>
              <label className="block text-sm text-text-muted mb-1.5">
                {draft.then === "waits-for-messages" ? "Runtime" : "Agent"}
              </label>
              <select
                value={draft.runtime}
                onChange={(e) => setDraft({ runtime: e.target.value })}
                className={INPUT}
              >
                {runtimes.map((r) => (
                  <option key={r.value || "shell"} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
              {local && (
                <p className="text-xs text-text-muted/60 mt-1">
                  Uses the CLI and login already on the machine. Copilot runs in pods only.
                </p>
              )}
              {draft.runtime === SHELL && (
                <p className="text-xs text-text-muted/60 mt-1">
                  <UserRound className="inline w-3 h-3 mr-1 -mt-0.5" />
                  Just you at a shell prompt — no agent, no prompt.
                </p>
              )}
            </div>

            {draft.then === "waits-for-messages" && (
              <div className="p-4 rounded-lg border border-border bg-bg-card/60 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div id="session-slug">
                    <label className="block text-sm text-text-muted mb-1.5">Slug</label>
                    <input
                      type="text"
                      value={draft.agent.slug}
                      onChange={(e) =>
                        setDraft((d) => ({
                          ...d,
                          agent: {
                            ...d.agent,
                            slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
                          },
                        }))
                      }
                      placeholder="forge"
                      className={cn(INPUT_INNER, "font-mono")}
                    />
                    <p className="text-xs text-text-muted/60 mt-1">
                      How other agents address it (a-z, 0-9, hyphens).
                    </p>
                  </div>
                  <div>
                    <label className="block text-sm text-text-muted mb-1.5">Display name</label>
                    <input
                      type="text"
                      value={draft.agent.name}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, agent: { ...d.agent, name: e.target.value } }))
                      }
                      placeholder={draft.title || "The Forge"}
                      className={INPUT_INNER}
                    />
                    <p className="text-xs text-text-muted/60 mt-1">Defaults to the title.</p>
                  </div>
                </div>
                <div>
                  <label className="block text-sm text-text-muted mb-1.5">Pod lifecycle</label>
                  <div className="flex gap-1.5 p-1 rounded-lg bg-bg border border-border w-fit">
                    {(
                      [
                        ["sticky", "Sticky"],
                        ["always-on", "Always on"],
                        ["on-demand", "On demand"],
                      ] as Array<[SessionDraft["agent"]["podLifecycle"], string]>
                    ).map(([v, label]) => (
                      <button
                        key={v}
                        type="button"
                        onClick={() =>
                          setDraft((d) => ({ ...d, agent: { ...d.agent, podLifecycle: v } }))
                        }
                        className={cn(
                          "px-3 py-1.5 rounded-md text-xs transition-colors",
                          draft.agent.podLifecycle === v
                            ? "bg-primary text-white"
                            : "text-text-muted hover:text-text",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-text-muted/80 mt-1.5">
                    {draft.agent.podLifecycle === "sticky"
                      ? "The pod stays warm for a while after each turn, then goes away until the next wake."
                      : draft.agent.podLifecycle === "always-on"
                        ? "The pod never goes away — fastest wake, highest cost."
                        : "A fresh pod for every turn — slowest wake, nothing idle."}
                  </p>
                </div>
                <Disclosure open={moreWho} onToggle={() => setMoreWho(!moreWho)} label="More">
                  <div className="space-y-3">
                    <div>
                      <label className="block text-sm text-text-muted mb-1.5">
                        Model <span className="text-text-muted/60">(optional override)</span>
                      </label>
                      <input
                        type="text"
                        value={draft.agent.model}
                        onChange={(e) =>
                          setDraft((d) => ({ ...d, agent: { ...d.agent, model: e.target.value } }))
                        }
                        className={cn(INPUT_INNER, "font-mono")}
                      />
                    </div>
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
                        Operator manual (agents.md){" "}
                        <span className="text-text-muted/60">
                          (optional — a default is provided)
                        </span>
                      </label>
                      <textarea
                        rows={4}
                        value={draft.agent.agentsMd}
                        onChange={(e) =>
                          setDraft((d) => ({
                            ...d,
                            agent: { ...d.agent, agentsMd: e.target.value },
                          }))
                        }
                        placeholder="Leave blank for Optio's standard manual: how to message other agents, read the inbox, and finish a turn."
                        className={cn(INPUT_INNER, "font-mono resize-y")}
                      />
                    </div>
                  </div>
                </Disclosure>
              </div>
            )}
          </div>
        </Section>

        {/* ── What ────────────────────────────────────────────────────── */}
        <Section label="What">
          <div className="space-y-4">
            <div id="session-title">
              <label className="block text-sm text-text-muted mb-1.5">
                Title
                {kind === "pod-session" || kind === "local-terminal" ? (
                  <span className="text-text-muted/60"> (optional)</span>
                ) : draft.when !== "manual" && draft.then === "exits" ? (
                  <span className="text-text-muted/60"> — also each run's title</span>
                ) : null}
              </label>
              <input
                type="text"
                value={draft.title}
                onChange={(e) => setDraft({ title: e.target.value })}
                placeholder={
                  draft.then === "waits-for-messages"
                    ? "Release manager"
                    : draft.withRepo
                      ? "Fix dependency vulnerabilities"
                      : "Weekly security report"
                }
                className={INPUT}
              />
            </div>

            {draft.runtime !== SHELL && (
              <div id="session-prompt">
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
                        if (t) setDraft({ prompt: t.template ?? t.content ?? "" });
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
                  rows={6}
                  value={draft.prompt}
                  onChange={(e) => setDraft({ prompt: e.target.value })}
                  placeholder={
                    draft.then === "waits-for-messages"
                      ? "Who this agent is and what it should do on its first turn."
                      : draft.withRepo
                        ? "Describe the change. Be specific about files to modify and expected behavior."
                        : "Describe what the agent should do. Reference Connections for external systems."
                  }
                  className={cn(INPUT, "resize-y")}
                />
                {draft.when !== "manual" && (
                  <p className="text-xs text-text-muted/60 mt-1">
                    Supports {"{{param}}"} substitution from the trigger payload.
                  </p>
                )}
              </div>
            )}

            <Disclosure open={moreWhat} onToggle={() => setMoreWhat(!moreWhat)} label="More">
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

        {/* ── When ────────────────────────────────────────────────────── */}
        <Section
          label="When"
          id="session-when"
          hint={
            whens.length === 1
              ? "A pod terminal is opened by hand."
              : draft.then === "waits-for-messages"
                ? "Messages always wake it. Add a schedule, webhook, or ticket source to wake it on its own too."
                : undefined
          }
        >
          {whens.length === 1 ? (
            <div className="flex gap-2 p-1 rounded-lg bg-bg-card border border-border w-fit">
              <TriggerTypeButton
                icon={<Terminal className="w-3.5 h-3.5" />}
                label="Now"
                active
                onClick={() => {}}
              />
            </div>
          ) : (
            <TriggerSelector
              value={draft.trigger}
              onChange={(trigger) => setDraft({ trigger, when: trigger.type })}
              manualLabel={draft.then === "waits-for-messages" ? "Messages" : "Manual"}
              extraActive={isEventWhen(draft.when)}
              extra={whens.filter(isEventWhen).map((w) => (
                <TriggerTypeButton
                  key={w}
                  icon={EVENT_META[w].icon}
                  label={EVENT_META[w].label}
                  active={draft.when === w}
                  onClick={() => setWhen(w)}
                />
              ))}
            />
          )}

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
        Event triggers run on your machine. Each firing opens a session in the chosen directory with
        the event's fields available as {"{{param}}"}s.
      </p>
    </div>
  );
}
