"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  getProviderCatalog,
  providerForAgentType,
  type ModelProvider,
  type PickableSecret,
  type WorkFormDefaults,
} from "@optio/shared";
import {
  Bot,
  CheckCircle2,
  Circle,
  Clock,
  FolderOpen,
  GitBranch as GitBranchIcon,
  GitMerge,
  GitPullRequest,
  History,
  Link2,
  Loader2,
  LogOut,
  MessageSquare,
  Play,
  Save,
  Sparkles,
  Terminal,
  Ticket,
  Webhook,
} from "lucide-react";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { ModeCard } from "@/components/mode-card";
import { NumberInput } from "@/components/number-input";
import { SectionCard as Section } from "@/components/ui/section-card";
import { Button, ButtonLink } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { FORM_WIDTH } from "@/components/ui/page";
import { PageHeader } from "@/components/page-header";
import { Segmented } from "@/components/ui/segmented";
import { Disclosure } from "@/components/ui/disclosure";
import { OwnerChip } from "@/components/ui/owner-chip";
import { AgentChoice, DefaultsHint } from "@/components/agent-choice";
import { RunLocationPicker } from "@/components/run-location-picker";
import { AgentIcon, PrIcon, TriggerIcon } from "@/components/brand-icon";
import { TriggerSelector, TriggerTypeButton, cronIsValid } from "@/components/trigger-selector";
import { GITHUB_KINDS, LINEAR_KINDS } from "@/components/local/automations-section";
import { useLocalHosts } from "@/hooks/use-local-hosts";
import { useCurrentUser } from "@/hooks/use-current-user";
import {
  EMPTY_DRAFT,
  KIND_NOUN,
  KIND_WORD,
  PRESETS,
  SLACK_CHANNEL_ID,
  TERMINAL,
  TRIGGER_PARAMS,
  WHEN_TYPES,
  describe,
  deriveKind,
  followThrough,
  fullOptionsApply,
  isEventWhen,
  isTriggered,
  isLocal,
  isOneShot,
  kindLock,
  missingFields,
  normalize,
  optionsFromRepo,
  runtimeLabel,
  runtimeOptions,
  slugify,
  thenOptions,
  whereOptions,
  addableSecrets,
  isPersonalOnlySecret,
  isPodWork,
  pickedProvider,
  providerDisabled,
  providerModelsFor,
  usableProviders,
  withOwner,
  withProvider,
  withSecret,
  withoutSecret,
  applyPreset as applyPresetTo,
  applyWorkDefaults,
  sameOptions,
  savedOptionsFor,
  startWith,
  withRepoDefaults,
  repoDefaultsApply,
  matchesRepoDefaults,
  resetToRepoDefaults,
  type EventTriggerType,
  type SentenceField,
  type WorkDraft,
  type Then,
  type WhenType,
  prSettingsApply,
  asksForPrompt,
  isCommand,
} from "./model";
import { createWork, rememberWorkDefaults, updateWork } from "./submit";
import { detailHref, type EditTarget } from "./load";
import { OwnerRow, SecretsRow } from "./who-extras";
import { EnvironmentPanel } from "./environment-panel";

/**
 * The one creation form. Six groups in dependency order — When, Where, Who,
 * What, Then, Name — each narrowing the next, and a sentence up
 * top that says what you're about to make. There is no "type" to pick: the
 * row it becomes is derived from the answers (`deriveKind`).
 *
 * Built from the pieces the dedicated forms already use: the mode cards,
 * the run-location picker, the trigger selector, the agent options picker,
 * the number input.
 */

const INPUT = inputClass();
// Every control sits inside a card now, so inputs use the page background throughout.
const INPUT_INNER = INPUT;

const FIELD_IDS: Record<SentenceField, string> = {
  checkout: "session-where",
  repo: "session-where",
  machine: "session-where",
  prompt: "session-prompt",
  cron: "session-when",
  webhook: "session-when",
  identity: "session-when",
  channel: "session-when",
  events: "session-when",
};

const PRESET_ICONS: Record<string, ReactNode> = {
  pr: <PrIcon colored={false} />,
  chat: <MessageSquare className="w-3.5 h-3.5" />,
  terminal: <Terminal className="w-3.5 h-3.5" />,
  schedule: <Clock className="w-3.5 h-3.5" />,
  agent: <Bot className="w-3.5 h-3.5" />,
};

const WHEN_META: Record<WhenType, { label: string; icon: ReactNode }> = {
  manual: { label: "Now", icon: <Play className="w-3.5 h-3.5" /> },
  schedule: { label: "Schedule", icon: <Clock className="w-3.5 h-3.5" /> },
  webhook: { label: "Webhook", icon: <Webhook className="w-3.5 h-3.5" /> },
  ticket: { label: "Ticket", icon: <Ticket className="w-3.5 h-3.5" /> },
  github: { label: "GitHub", icon: <TriggerIcon type="github" /> },
  slack: { label: "Slack", icon: <TriggerIcon type="slack" /> },
  linear: { label: "Linear", icon: <TriggerIcon type="linear" /> },
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
      "The agent does one turn of work and the run finishes. On a branch, it opens the PR first.",
  },
  "until-merged": {
    icon: <GitMerge className="w-5 h-5" />,
    title: "Work until merged",
    subtitle: "Follows the PR through",
    description:
      "Opens a PR, then comes back to fix failing CI, conflicts, and review feedback until it merges.",
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

/**
 * With `edit`, the same form reopens saved recurring work — a scheduled
 * Task, a Job, or a Local automation — prefilled from its row. The kind is
 * fixed for the edit (`kindLock`); everything inside it is fair game, and
 * Save patches the row and its trigger in place.
 */
export function WorkForm({ edit }: { edit?: EditTarget } = {}) {
  const router = useRouter();
  const locked = edit?.kind ?? null;
  const [draft, setDraftRaw] = useState<WorkDraft>(() =>
    edit ? edit.draft : normalize(PRESETS[0].apply(EMPTY_DRAFT)),
  );
  const [preset, setPreset] = useState<string | null>(edit ? null : PRESETS[0].id);
  const [submitting, setSubmitting] = useState(false);
  const [more, setMore] = useState(false);
  const [showDeps, setShowDeps] = useState(false);

  const [repos, setRepos] = useState<any[]>([]);
  const [reposLoading, setReposLoading] = useState(true);
  const [templates, setTemplates] = useState<any[]>([]);
  const [existingTasks, setExistingTasks] = useState<any[]>([]);
  const [workCount, setWorkCount] = useState<number | null>(null);
  // The signed-in account: its provider handle (GitHub login) prefills "about
  // you" event triggers; an admin may make organization secrets.
  const { user: me, userId, isAdmin } = useCurrentUser();
  // Model providers you can pick, and secret names a pod can get (never values).
  const [providers, setProviders] = useState<ModelProvider[]>([]);
  const [providersLoaded, setProvidersLoaded] = useState(false);
  // Your last-used runtime + per-runtime options (GET /api/me/work-defaults);
  // null until loaded, and never fetched for an edit.
  const [savedDefaults, setSavedDefaults] = useState<WorkFormDefaults | null>(null);
  // Runtimes whose options you've changed here: switching back to one starts
  // from scratch, not your saved settings, and drops the "last settings" hint.
  const touchedRuntimes = useRef(new Set<string>());
  const defaultsApplied = useRef(false);
  const [pickable, setPickable] = useState<PickableSecret[]>([]);
  // One line under Owner after a private pick switched it to you.
  const [ownerNote, setOwnerNote] = useState<string | null>(null);
  const { hosts } = useLocalHosts();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const runNameRef = useRef<HTMLInputElement>(null);

  // On a machine the checkout's git remote is the repo (the picker reports it).
  const [localRepoUrl, setLocalRepoUrl] = useState<string | null>(null);

  const setDraft = useCallback((patch: Partial<WorkDraft> | ((d: WorkDraft) => WorkDraft)) => {
    setDraftRaw((d) => normalize(typeof patch === "function" ? patch(d) : { ...d, ...patch }));
    setPreset(null);
  }, []);

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
      .then((res) => setWorkCount(res.total ?? null))
      .catch(() => setWorkCount(null));
    api
      .listModelProviders()
      .then((res) => setProviders(res.providers ?? []))
      .catch(() => setProviders([]))
      .finally(() => setProvidersLoaded(true));
    if (!edit) {
      api
        .getWorkDefaults()
        .then((res) => setSavedDefaults(res.defaults ?? {}))
        .catch(() => setSavedDefaults({}));
    }
    api
      .listPickableSecrets()
      .then((res) => setPickable(res.secrets ?? []))
      .catch(() => setPickable([]));
  }, []);

  // Someone else's private work (an admin's view): read-only, named in the banner.
  const foreignOwnerId = edit?.foreignOwnerId ?? null;
  const foreignOwnerName = edit?.foreignOwnerName ?? null;
  const readOnly = !!foreignOwnerId;

  // Pre-select the saved repo (by url) or the first one once the list is
  // known, like the Task form did. A new draft starts its agent from the
  // repo's saved defaults when the repo has its own (`withRepoDefaults`).
  useEffect(() => {
    if (!draft.repoId && repos.length > 0) {
      const first = repos.find((r: any) => r.repoUrl === draft.repoUrl) ?? repos[0];
      setDraftRaw((d) => {
        if (d.repoId) return d;
        const next: WorkDraft = {
          ...d,
          repoId: first.id,
          repoUrl: first.repoUrl,
          // An edit keeps what the row saved; a new draft starts from the repo.
          repoBranch: edit ? d.repoBranch : (first.defaultBranch ?? "main"),
        };
        if (edit) return next;
        // (or keeps your saved settings, when those were applied first).
        const seeded = Object.keys(d.agentOptions).length
          ? next
          : { ...next, agentOptions: optionsFromRepo(d.runtime, first) };
        return withRepoDefaults(seeded, first);
      });
    }
  }, [repos, draft.repoId]);

  // A blank New work form starts from your last settings — once, and only
  // while it is still the untouched first example (not an edit, not another
  // example, not anything you've changed).
  // A repo with saved defaults of its own still wins for pod work with it.
  useEffect(() => {
    if (edit || defaultsApplied.current || !savedDefaults || !providersLoaded || reposLoading) {
      return;
    }
    defaultsApplied.current = true;
    const repoOf = (d: WorkDraft) => repos.find((r: any) => r.id === d.repoId);
    if (preset === PRESETS[0].id) {
      setDraftRaw((d) =>
        withRepoDefaults(applyWorkDefaults(d, savedDefaults, providers), repoOf(d)),
      );
    } else if (preset) {
      // Another chip clicked before the settings loaded: fill its blank options.
      const p = PRESETS.find((x) => x.id === preset);
      if (p) {
        setDraftRaw((d) => applyPresetTo(d, p, savedDefaults, providers, new Set(), repoOf(d)));
      }
    }
  }, [savedDefaults, providersLoaded, reposLoading]);

  /** Where a runtime's parameters start: your saved ones unless you've changed them here. */
  // (A repo with saved defaults of its own wins for pod work with it.)
  const startOptions = (d: WorkDraft, runtime: string): WorkDraft => {
    const saved = touchedRuntimes.current.has(runtime)
      ? null
      : savedOptionsFor(savedDefaults, runtime, providers);
    const repo = repos.find((r: any) => r.id === d.repoId);
    return startWith(d, runtime, repo, saved, providers);
  };

  // If GitHub was picked before the account loaded, fill the login in now.
  useEffect(() => {
    if (!me?.username || me.provider !== "github") return;
    setDraftRaw((d) =>
      d.when === "github" && !String(d.event.config.login ?? "").trim()
        ? { ...d, event: { ...d.event, config: { ...d.event.config, login: me.username } } }
        : d,
    );
  }, [me]);

  // A pod Task starts from the repo's configured parameters for the picked
  // runtime, so the picker shows what will actually run.
  const seedFromRepo = fullOptionsApply(draft) && draft.withRepo;
  const seedKey = `${draft.runtime}|${draft.repoId}|${seedFromRepo}`;
  useEffect(() => {
    if (!seedFromRepo) return;
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
  // The repo whose settings decide what happens to the PR (on a machine, the
  // registered repo the checkout belongs to, if any).
  const policyRepo =
    repoRow ?? (effectiveRepoUrl ? repos.find((r: any) => r.repoUrl === effectiveRepoUrl) : null);
  const prPlan = followThrough(draft, policyRepo);
  const canSubmit =
    !readOnly && !submitting && gaps.length === 0 && (!draft.withRepo || !!effectiveRepoUrl);
  // Named for what it is ("Job 12", "Terminal 12"), numbered after everything
  // the unified list counts; while the count is unknown (or the API predates
  // `total`) fall back to a timestamp so two unnamed rows never collide.
  const autoName = `${KIND_WORD[kind]} ${
    workCount == null ? new Date().toISOString().slice(0, 16).replace("T", " ") : workCount + 1
  }`;
  const params = TRIGGER_PARAMS[draft.when];
  const isTerminal = draft.runtime === TERMINAL;

  const applyPreset = (id: string) => {
    const p = PRESETS.find((x) => x.id === id);
    if (!p) return;
    // A chip that leaves the options blank starts from your saved settings.
    setDraftRaw((d) =>
      applyPresetTo(
        d,
        p,
        savedDefaults,
        providers,
        touchedRuntimes.current,
        repos.find((r: any) => r.id === d.repoId),
      ),
    );
    setPreset(id);
  };

  const handleRepoChange = (repoId: string) => {
    const repo = repos.find((r: any) => r.id === repoId);
    if (!repo) return;
    // The agent and its parameters start from the repo's saved defaults.
    setDraft((d) =>
      withRepoDefaults(
        startOptions(
          {
            ...d,
            repoId: repo.id,
            repoUrl: repo.repoUrl,
            repoBranch: repo.defaultBranch ?? "main",
          },
          d.runtime,
        ),
        repo,
      ),
    );
  };

  const setWhen = (w: WhenType) => {
    setDraft((d) => {
      if (isEventWhen(w)) {
        // Prefill "you" from the signed-in account when the provider matches.
        const config = { ...DEFAULT_EVENT_CONFIG[w] };
        if (w === "github" && me?.provider === "github" && me.username) config.login = me.username;
        return {
          ...d,
          when: w,
          trigger: { type: "manual" },
          event: d.event.type === w ? d.event : { type: w, config },
        };
      }
      return { ...d, when: w };
    });
  };

  const setWhere = (runTarget: "cluster" | "local") => {
    // A pod defaults to one of your repos; a machine to the directory as it
    // is. An edit keeps the saved answer, since it is part of the kind.
    setDraft((d) =>
      startOptions(
        {
          ...d,
          location: { ...d.location, runTarget },
          withRepo: edit ? d.withRepo : runTarget === "cluster",
        },
        d.runtime,
      ),
    );
  };

  // The picker starts from the repo's defaults only while there is a repo;
  // switching it off (or on) starts the parameters over.
  const setWithRepo = (withRepo: boolean) =>
    setDraft((d) => startOptions({ ...d, withRepo }, d.runtime));

  // Recurring work names each run; a one-off run just takes the name.
  const namesRuns =
    kind === "repo-blueprint" ||
    kind === "local-blueprint" ||
    (kind === "standalone" && isTriggered(draft));

  const insertParam = (name: string, field: "prompt" | "runName" = "prompt") => {
    const token = `{{${name}}}`;
    const el = field === "prompt" ? promptRef.current : runNameRef.current;
    setDraft((d) => {
      const text = d[field];
      if (!el) {
        const sep = text && !text.endsWith(" ") ? " " : "";
        return { ...d, [field]: `${text}${sep}${token}` };
      }
      const start = el.selectionStart ?? text.length;
      const end = el.selectionEnd ?? text.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(start + token.length, start + token.length);
      });
      return { ...d, [field]: text.slice(0, start) + token + text.slice(end) };
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
      const created = edit
        ? await updateWork(edit, draft, { repoUrl: effectiveRepoUrl })
        : await createWork(draft, { repoUrl: effectiveRepoUrl, autoName });
      // Remember what you picked for next time (never blocks the submit).
      if (!edit) rememberWorkDefaults(draft);
      toast.success(created.toast);
      router.push(created.href);
    } catch (err) {
      toast.error(edit ? "Couldn't save it" : "Couldn't create it", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
      setSubmitting(false);
    }
  };

  const submitLabel = edit
    ? "Save changes"
    : kind === "persistent-agent"
      ? "Create agent"
      : draft.when === "manual"
        ? draft.then === "until-merged"
          ? "Start work (until merged)"
          : draft.then === "exits"
            ? draft.withRepo
              ? "Start work (opens a PR)"
              : "Start work"
            : "Open session"
        : "Save";

  // The kind's own rules first, then (editing) the lock on the saved kind.
  const lock = (patch: Partial<WorkDraft>) => kindLock(draft, locked, patch);
  const wheres = whereOptions(draft);
  const runtimes = runtimeOptions(draft).map((r) => ({
    ...r,
    disabled: r.disabled ?? lock({ runtime: r.value, agentOptions: {} }),
  }));
  const thens = thenOptions(draft).map((c) => ({
    ...c,
    disabled: c.disabled ?? lock({ then: c.value }),
  }));
  const podDisabled =
    wheres.find((w) => w.value === "cluster")?.disabled ??
    lock({ location: { ...draft.location, runTarget: "cluster" } });
  const machineDisabled = lock({ location: { ...draft.location, runTarget: "local" } });
  const whenDisabled = Object.fromEntries(
    WHEN_TYPES.map((w) => [
      w,
      lock(
        isEventWhen(w)
          ? { when: w, trigger: { type: "manual" } }
          : { when: w, trigger: { type: w } },
      ),
    ]),
  ) as Record<WhenType, string | undefined>;
  const withRepoDisabled = (withRepo: boolean) => lock({ withRepo, agentOptions: {} });
  const detail = edit ? detailHref(edit) : null;

  // One line per card header — the answer so far, readable when scrolled past.
  const catalog = isTerminal ? null : getProviderCatalog(providerForAgentType(draft.runtime));
  const rawModel = catalog ? String(draft.agentOptions[catalog.modelField] ?? "") : "";
  const modelId = catalog?.aliases[rawModel] ?? rawModel; // "opus" → the latest Opus
  // Model providers: offered only when one serves this runtime.
  const provider = pickedProvider(draft, providers);
  const providerChoices = usableProviders(draft, providers);
  const providerModels = providerModelsFor(draft, provider);
  const podWork = isPodWork(draft);
  // Every piece of pod work has an Owner: the organization's or yours. A
  // private provider or secret picked below switches it to you (`withOwner`
  // and friends in the model), with `ownerNote` saying why. The Owner row
  // sits in Where, above the environment it governs.
  const showSecrets = podWork && (pickable.length > 0 || (draft.podSecrets?.length ?? 0) > 0);
  // "Your last settings" while the parameters are still the saved ones.
  const savedForRuntime =
    !edit && !touchedRuntimes.current.has(draft.runtime)
      ? savedOptionsFor(savedDefaults, draft.runtime, providers)
      : null;
  const lastSettingsShown = !!savedForRuntime && sameOptions(draft.agentOptions, savedForRuntime);
  const resetLastSettings = () => {
    touchedRuntimes.current.add(draft.runtime);
    setDraft((d) => ({
      ...d,
      agentOptions: fullOptionsApply(d) && d.withRepo ? optionsFromRepo(d.runtime, repoRow) : {},
    }));
  };
  // Otherwise, for pod work with a repo: are these still the repo's defaults?
  const repoHint =
    !edit && !lastSettingsShown && repoDefaultsApply(draft) && repoRow
      ? matchesRepoDefaults(draft, repoRow)
        ? "same"
        : "changed"
      : null;
  const resetRepoDefaults = () => {
    touchedRuntimes.current.add(draft.runtime);
    setDraft((d) => resetToRepoDefaults(d, repoRow));
  };
  const modelLabel = modelId
    ? (providerModels?.find((m) => m.id === modelId)?.label ??
      catalog?.models.find((m) => m.id === modelId)?.label ??
      modelId)
    : "";
  const summaries = {
    when: WHEN_META[draft.when].label,
    where: local
      ? `${machine?.name ?? "My machine"}${draft.withRepo ? " · new branch" : ""}`
      : `Optio pod · ${draft.withRepo ? (repoRow?.fullName ?? "a repo") : "no repo"}`,
    who: isTerminal
      ? "Terminal"
      : `${runtimeLabel(draft.runtime)}${modelLabel ? ` · ${modelLabel}` : ""}${
          provider ? ` · ${provider.name}` : ""
        }`,
    then: THEN_CARDS[draft.then].title,
    name: draft.name.trim() || autoName,
  };

  return (
    <div className="page-column py-6">
      {edit ? (
        <PageHeader
          icon={Terminal}
          title="Edit work"
          description={
            <>
              The same five answers you gave when you made it. It stays {KIND_NOUN[edit.kind]}; to
              turn it into something else,{" "}
              <Link href="/work/new" className="text-primary hover:underline">
                start new work
              </Link>
              .
            </>
          }
          actions={
            detail && (
              <ButtonLink href={detail} variant="secondary">
                <History />
                Runs & history
              </ButtonLink>
            )
          }
        />
      ) : (
        <PageHeader
          icon={Terminal}
          title="New work"
          description="Everything Optio runs is work — a terminal, an agent run, a recurring job, a persistent agent. Say what starts it, where it runs, who drives it, what it does, and what happens when a turn ends."
        />
      )}
      <div className={FORM_WIDTH}>
        {/* ── Examples: shortcuts that fill the form in, not a setting ─────── */}
        <div
          className={cn(
            "flex flex-wrap items-center gap-x-1 gap-y-1.5 mb-5 text-xs text-text-muted",
            edit && "hidden",
          )}
        >
          <span className="mr-1">Examples:</span>
          {PRESETS.map((p, i) => (
            <span key={p.id} className="flex items-center">
              {i > 0 && <span className="mx-1 text-text-muted/40">·</span>}
              <button
                type="button"
                title={p.hint}
                onClick={() => applyPreset(p.id)}
                className={cn(
                  "inline-flex items-center gap-1 rounded px-1 -mx-1 underline decoration-dotted underline-offset-4 transition-colors",
                  preset === p.id
                    ? "text-primary decoration-primary/60"
                    : "decoration-text-muted/40 hover:text-text hover:decoration-text-muted",
                )}
              >
                {PRESET_ICONS[p.id]}
                {p.label}
              </button>
            </span>
          ))}
        </div>

        {readOnly && (
          <div className="flex flex-wrap items-center gap-2 mb-4 px-3 py-2.5 rounded-md border border-warning/30 bg-warning/5 text-sm text-warning">
            <OwnerChip
              size="sm"
              row={{ ownerUserId: foreignOwnerId, ownerName: foreignOwnerName }}
              viewerId={userId}
            />
            <p>— read-only. It runs with their credentials.</p>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <fieldset disabled={readOnly} className="space-y-4 min-w-0">
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
            <Section
              step={1}
              label="When"
              hint="What starts it?"
              summary={summaries.when}
              id="session-when"
            >
              <TriggerSelector
                value={draft.trigger}
                onChange={(trigger) => setDraft({ trigger, when: trigger.type })}
                manualLabel="Now"
                inset
                disabledTypes={whenDisabled}
                extraActive={isEventWhen(draft.when)}
                extra={WHEN_TYPES.filter(isEventWhen).map((w) => (
                  <TriggerTypeButton
                    key={w}
                    icon={WHEN_META[w].icon}
                    label={WHEN_META[w].label}
                    active={draft.when === w}
                    onClick={() => setWhen(w)}
                    disabled={whenDisabled[w]}
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
            <Section
              step={2}
              label="Where"
              hint="A pod, or your machine?"
              summary={summaries.where}
              id="session-where"
            >
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
                  inset
                  clusterDisabled={podDisabled}
                  localDisabled={machineDisabled}
                />

                <div className="pt-3 border-t border-border space-y-3">
                  {local ? (
                    <>
                      <Segmented
                        value={draft.withRepo ? "branch" : "current"}
                        onChange={(v) => setWithRepo(v === "branch")}
                        options={[
                          {
                            value: "current",
                            label: "Current directory",
                            icon: <FolderOpen className="w-3 h-3" />,
                            disabled: withRepoDisabled(false),
                          },
                          {
                            value: "branch",
                            label: "New branch",
                            icon: <GitBranchIcon className="w-3 h-3" />,
                            disabled: withRepoDisabled(true),
                          },
                        ]}
                      />
                      {draft.withRepo ? (
                        <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] sm:items-end gap-3">
                          <div className="sm:w-56">
                            <label className="block text-sm text-text-muted mb-1.5">
                              Base branch
                            </label>
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
                          Works in the directory as it is, on whatever branch is checked out.
                          Nothing is pushed unless you or the agent do it.
                        </p>
                      )}
                    </>
                  ) : (
                    <>
                      <Segmented
                        value={draft.withRepo ? "repo" : "none"}
                        onChange={(v) => setWithRepo(v === "repo")}
                        options={[
                          {
                            value: "repo",
                            label: "A repository",
                            icon: <GitPullRequest className="w-3 h-3" />,
                            disabled: withRepoDisabled(true),
                          },
                          {
                            value: "none",
                            label: "No repo",
                            icon: <Terminal className="w-3 h-3" />,
                            disabled: withRepoDisabled(false),
                          },
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
                              <label className="block text-sm text-text-muted mb-1.5">
                                Repository
                              </label>
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

                {podWork && (
                  <div className="pt-3 border-t border-border space-y-3">
                    {/* Owner first: it decides which private secrets, connections,
                      MCP servers and skills the environment below can offer. */}
                    <OwnerRow
                      owner={draft.owner}
                      note={ownerNote}
                      onChange={(owner) => {
                        setOwnerNote(null);
                        setDraft((d) => withOwner(d, owner, providers, pickable));
                      }}
                    />
                    <EnvironmentPanel
                      settings={draft.settings}
                      repoUrl={draft.withRepo ? effectiveRepoUrl || null : null}
                      agentType={draft.runtime}
                      owner={draft.owner}
                      prApplies={prSettingsApply(draft)}
                      command={isCommand(draft)}
                      secrets={
                        showSecrets ? (
                          <SecretsRow
                            picked={draft.podSecrets ?? []}
                            pickable={pickable}
                            addable={addableSecrets(draft, pickable)}
                            canCreateOrg={isAdmin}
                            onAdd={(x) => {
                              if (
                                x.owner === "me" &&
                                draft.owner !== "me" &&
                                isPersonalOnlySecret(x.name, pickable)
                              ) {
                                setOwnerNote(
                                  `${x.name} is your own secret, so this work now runs as you.`,
                                );
                              }
                              setDraft((d) =>
                                // A name the org also has stays org-safe.
                                x.owner === "me" && !isPersonalOnlySecret(x.name, pickable)
                                  ? withSecret(d, { ...x, owner: "workspace" })
                                  : withSecret(d, x),
                              );
                            }}
                            onRemove={(name) => setDraft((d) => withoutSecret(d, name))}
                            onCreated={(x) => {
                              setPickable((list) => [...list, x]);
                              if (x.owner === "me" && draft.owner !== "me") {
                                setOwnerNote(
                                  `${x.name} is your own secret, so this work now runs as you.`,
                                );
                              }
                              setDraft((d) => withSecret(d, x));
                            }}
                          />
                        ) : null
                      }
                      onChange={(settings) => setDraft((d) => ({ ...d, settings }))}
                    />
                  </div>
                )}
              </div>
            </Section>

            {/* ── Who ─────────────────────────────────────────────────────── */}
            <Section
              step={3}
              label="Who"
              hint="A terminal, or an agent?"
              summary={summaries.who}
              summaryIcon={<AgentIcon runtime={draft.runtime} className="w-3 h-3" />}
              id="session-who"
            >
              <div className="space-y-3">
                <AgentChoice
                  runtime={draft.runtime}
                  agentOptions={draft.agentOptions}
                  runtimes={runtimes}
                  onRuntimeChange={(runtime) => setDraft((d) => startOptions(d, runtime))}
                  onOptionsChange={(agentOptions) => {
                    touchedRuntimes.current.add(draft.runtime);
                    setDraft({ agentOptions });
                  }}
                  note={
                    isTerminal
                      ? "Just you at a shell prompt — no agent, no prompt."
                      : kind === "pod-session"
                        ? "A pod session opens a terminal and a Claude Code chat side by side — you type the first message there."
                        : local
                          ? "Uses the CLI and login already on the machine."
                          : "Runs with the server's agent credentials."
                  }
                  paramsHint={
                    local
                      ? "What the machine's CLI takes — the rest comes from its own config"
                      : draft.withRepo
                        ? "Starts from the repo's defaults; applies to this run only"
                        : "Blank means the runtime's default"
                  }
                  providers={{
                    choices: providerChoices,
                    picked: provider,
                    disabledReason: (p) => providerDisabled(draft, p, machine),
                    onPick: (p) => {
                      if (p && p.ownerUserId !== null && !local && draft.owner !== "me") {
                        setOwnerNote(`${p.name} is yours, so this work now runs as you.`);
                      }
                      touchedRuntimes.current.add(draft.runtime);
                      setDraft((d) => withProvider(d, p));
                    },
                  }}
                  providerModels={providerModels}
                  runsOn={fullOptionsApply(draft) ? "pod" : "local"}
                  hostId={local ? draft.location.localHostId || undefined : undefined}
                  footer={
                    lastSettingsShown ? (
                      <DefaultsHint testId="work-last-settings" onReset={resetLastSettings}>
                        Your last settings
                      </DefaultsHint>
                    ) : repoHint ? (
                      <DefaultsHint testId="work-repo-defaults" onReset={resetRepoDefaults}>
                        {repoHint === "same" ? "Repo defaults" : "Changed from the repo's defaults"}
                      </DefaultsHint>
                    ) : null
                  }
                />
              </div>
            </Section>

            {/* ── What ────────────────────────────────────────────────────── */}
            {asksForPrompt(draft) && (
              <Section
                step={4}
                label="What"
                hint={isCommand(draft) ? "The command" : "The prompt"}
                id="session-prompt"
              >
                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="block text-sm text-text-muted">
                      {isCommand(draft)
                        ? "Command"
                        : draft.then === "waits-for-messages"
                          ? "Initial prompt"
                          : "Prompt"}
                      {kind === "local-terminal" && (
                        <span className="text-text-muted/60"> (optional)</span>
                      )}
                    </label>
                    {templates.length > 0 && !isCommand(draft) && (
                      <select
                        value=""
                        onChange={(e) => {
                          const t = templates.find((x) => x.id === e.target.value);
                          if (t) setDraft({ prompt: t.template ?? "" });
                        }}
                        className={inputClass({ size: "sm", className: "w-auto text-text-muted" })}
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
                      isCommand(draft)
                        ? "./scripts/nightly-report.sh --since yesterday"
                        : draft.when === "ticket" || draft.when === "linear"
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
                          <>
                            From the {WHEN_META[draft.when].label} trigger — click to insert
                            {isCommand(draft) ? " (each value is shell-quoted)" : ""}:
                          </>
                        ) : draft.when === "webhook" ? (
                          <>
                            Each top-level field of the POSTed JSON is available as{" "}
                            <code className="font-mono">{"{{field}}"}</code> (nested values arrive
                            as JSON text).
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
                              className="px-1.5 py-0.5 rounded bg-bg border border-border font-mono text-[11px] text-text-muted hover:text-text hover:border-primary/50 transition-colors"
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

            {/* ── Then ─────────────────────────────────────────── */}
            <Section
              step={asksForPrompt(draft) ? 5 : 4}
              label="Then"
              hint="What happens when a turn ends?"
              summary={summaries.then}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

              {prPlan && (
                <div className="mt-3 pt-3 border-t border-border space-y-3">
                  {draft.then === "until-merged" && (
                    <label className="flex items-start gap-2 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={draft.mergeWhenReady}
                        onChange={(e) => setDraft({ mergeWhenReady: e.target.checked })}
                        className="mt-0.5"
                      />
                      <span>
                        Merge it for me when it&apos;s ready
                        <span className="block text-xs text-text-muted">
                          Off: the agent keeps the PR green and addresses feedback, and you merge
                          it.
                        </span>
                      </span>
                    </label>
                  )}
                  <div>
                    <div className="text-sm text-text-muted mb-1.5">What happens to the PR</div>
                    <ol className="space-y-1.5">
                      {prPlan.steps.map((step) => (
                        <li key={step.key} className="flex items-start gap-2 text-sm">
                          {step.on ? (
                            <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-success" />
                          ) : (
                            <Circle className="w-4 h-4 mt-0.5 shrink-0 text-text-muted/50" />
                          )}
                          <span className={cn(!step.on && "text-text-muted")}>
                            {step.label}
                            {step.detail && (
                              <span className="block text-xs text-text-muted">{step.detail}</span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                    <p className="text-[11px] text-text-muted/80 mt-2">
                      {prPlan.fromRepo ? (
                        <>
                          Following {policyRepo ? (policyRepo.fullName ?? "the repo") : "the repo"}
                          &apos;s settings
                          {policyRepo?.id && (
                            <>
                              {" "}
                              (
                              <Link
                                href={`/repos/${policyRepo.id}`}
                                className="text-primary hover:underline"
                              >
                                change them
                              </Link>
                              )
                            </>
                          )}
                          . Pick <span className="font-medium">Work until merged</span> to follow
                          this PR through whatever they say.
                        </>
                      ) : (
                        <>
                          This work&apos;s own setting, over the repo&apos;s. Review and cautious
                          mode still come from the repo.
                        </>
                      )}
                    </p>
                  </div>
                </div>
              )}

              {draft.then === "waits-for-messages" && (
                <div className="mt-3 pt-3 border-t border-border space-y-3">
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
                          setDraft((d) => ({
                            ...d,
                            agent: { ...d.agent, agentsMd: e.target.value },
                          }))
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
            <Section
              step={asksForPrompt(draft) ? 6 : 5}
              label="Name"
              summary={summaries.name}
              id="session-name"
            >
              <div className="space-y-3">
                <div
                  className={cn(
                    "grid gap-3",
                    draft.then === "waits-for-messages" && "sm:grid-cols-2",
                  )}
                >
                  <div>
                    <input
                      type="text"
                      value={draft.name}
                      onChange={(e) => setDraft({ name: e.target.value })}
                      placeholder={edit ? String(edit.row.name ?? "") : autoName}
                      className={INPUT}
                    />
                    <p className="text-xs text-text-muted/60 mt-1">
                      {draft.name.trim()
                        ? kind === "repo-task" ||
                          (kind === "repo-blueprint" && !draft.runName.trim())
                          ? "Also the title of the task that opens the PR."
                          : " "
                        : edit
                          ? "Leave blank to keep the current name."
                          : `Leave blank to call it “${autoName}”.`}
                    </p>
                  </div>
                  {namesRuns && (
                    <div>
                      <label className="block text-sm text-text-muted mb-1.5">
                        Each run is named <span className="text-text-muted/60">(optional)</span>
                      </label>
                      <input
                        ref={runNameRef}
                        type="text"
                        value={draft.runName}
                        onChange={(e) => setDraft({ runName: e.target.value })}
                        placeholder={
                          params.includes("ticketTitle")
                            ? "Triage: {{ticketTitle}}"
                            : params.includes("title")
                              ? "Review: {{title}}"
                              : draft.name.trim() || autoName
                        }
                        className={cn(INPUT, "font-mono")}
                      />
                      <p className="text-xs text-text-muted/60 mt-1">
                        {params.length > 0
                          ? "Filled in from the trigger each time it fires. Blank = the name above."
                          : draft.when === "webhook"
                            ? "Use {{field}} for any top-level field of the POSTed JSON. Blank = the name above."
                            : "Blank = the name above."}
                      </p>
                      {params.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-1.5">
                          {params.map((name) => (
                            <button
                              key={name}
                              type="button"
                              onClick={() => insertParam(name, "runName")}
                              className="px-1.5 py-0.5 rounded bg-bg border border-border font-mono text-[11px] text-text-muted hover:text-text hover:border-primary/50 transition-colors"
                            >
                              {`{{${name}}}`}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
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
                        placeholder="Why does this exist? Who asked for it?"
                        className={INPUT}
                      />
                    </div>
                    {isOneShot(draft.then) && (
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
                              className={inputClass({ className: "w-24" })}
                            />
                            <p className="text-xs text-text-muted/60 mt-1">
                              Lower = sooner. Default 100.
                            </p>
                          </div>
                        )}
                        {/* A Local automation's runs are terminals; they don't retry. */}
                        {locked !== "local-blueprint" && (
                          <div>
                            <label className="block text-sm text-text-muted mb-1.5">
                              Max retries
                            </label>
                            <NumberInput
                              min={0}
                              max={10}
                              value={draft.maxRetries}
                              onChange={(v) => setDraft({ maxRetries: v })}
                              fallback={3}
                              className={inputClass({ className: "w-24" })}
                            />
                          </div>
                        )}
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
                              Wait for these to complete first.
                            </p>
                            {existingTasks.filter(
                              (t) => !["completed", "cancelled"].includes(t.state),
                            ).length === 0 ? (
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
              <div className="flex items-center gap-3">
                {edit && (
                  <ButtonLink href={detail!} variant="ghost">
                    Cancel
                  </ButtonLink>
                )}
                <Button type="submit" disabled={!canSubmit}>
                  {submitting ? (
                    <Loader2 className="animate-spin" />
                  ) : edit ? (
                    <Save />
                  ) : draft.when !== "manual" ? (
                    <Clock />
                  ) : draft.then === "waits-for-messages" ? (
                    <Bot />
                  ) : draft.then === "waits-for-me" ? (
                    <Terminal />
                  ) : draft.then === "until-merged" ? (
                    <GitMerge />
                  ) : draft.withRepo ? (
                    <GitPullRequest />
                  ) : (
                    <Sparkles />
                  )}
                  {submitting ? (edit ? "Saving..." : "Creating...") : submitLabel}
                </Button>
              </div>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}

/** Comma-separated list ⇄ string[] for the filter fields. */
function listValue(v: unknown): string {
  return Array.isArray(v) ? (v as string[]).join(", ") : "";
}
function parseList(text: string): string[] {
  return text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The event-trigger config for a Local automation, in the shape the
 * `/api/local/blueprints/:id/triggers` route stores — the same fields the
 * editor in `local/automations-section.tsx` offers, with the identity
 * prefilled from the signed-in account where the provider matches.
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
  // "Only tickets from someone else" needs to know who you are, whatever the events.
  const othersOnly = type === "linear" && config.othersOnly === true;
  const personal = kinds.some((k) => k.personal && events.includes(k.value)) || othersOnly;
  const identityKey = type === "github" ? "login" : "user";
  const identity = String(config[identityKey] ?? "");
  const postedBy = String(config.postedBy ?? "people");
  const listField = (key: string, label: string, placeholder: string) => (
    <div>
      <label className="block text-xs text-text-muted mb-1">
        {label} <span className="text-text-muted/60">(optional)</span>
      </label>
      <input
        type="text"
        value={listValue(config[key])}
        onChange={(e) => onChange({ ...config, [key]: parseList(e.target.value) })}
        placeholder={placeholder}
        className={INPUT_INNER}
      />
    </div>
  );

  return (
    <div className="mt-3 pt-3 border-t border-border space-y-3">
      {type === "slack" ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Channel id</label>
              <input
                type="text"
                value={String(config.channelId ?? "")}
                onChange={(e) => onChange({ ...config, channelId: e.target.value.trim() })}
                placeholder="C0123ABCD"
                aria-invalid={!SLACK_CHANNEL_ID.test(String(config.channelId ?? ""))}
                className={cn(INPUT_INNER, "font-mono")}
              />
              <p className="text-[11px] text-text-muted/60 mt-1">
                From the channel's details in Slack — the id, not the name.
              </p>
            </div>
            <div>
              <label className="block text-xs text-text-muted mb-1">
                Keyword <span className="text-text-muted/60">(optional)</span>
              </label>
              <input
                type="text"
                value={String(config.keyword ?? "")}
                onChange={(e) => onChange({ ...config, keyword: e.target.value })}
                placeholder="Only messages containing this"
                className={INPUT_INNER}
              />
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-text-muted mb-1">Posted by</label>
              <select
                value={postedBy}
                onChange={(e) => {
                  const next: Record<string, unknown> = { ...config, postedBy: e.target.value };
                  // People only: a bot to match would be left over, unseen.
                  if (e.target.value === "people") delete next.bot;
                  onChange(next);
                }}
                className={INPUT_INNER}
              >
                <option value="people">People</option>
                <option value="bots">Bots (apps, integrations, alerts)</option>
                <option value="anyone">Anyone</option>
              </select>
              <p className="text-[11px] text-text-muted/60 mt-1">
                {postedBy === "people"
                  ? "Bots' posts don't start it."
                  : "Posts by Optio's own Slack app never do."}
              </p>
            </div>
            {postedBy !== "people" && (
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  Bot <span className="text-text-muted/60">(optional)</span>
                </label>
                <input
                  type="text"
                  value={String(config.bot ?? "")}
                  onChange={(e) => onChange({ ...config, bot: e.target.value })}
                  placeholder="Any bot"
                  className={INPUT_INNER}
                />
                <p className="text-[11px] text-text-muted/60 mt-1">
                  The name on its posts, or its bot id (B0123…) or app id (A0123…).
                </p>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={!!config.mentionOnly}
                onChange={(e) => onChange({ ...config, mentionOnly: e.target.checked })}
              />
              Only when the app is @-mentioned
            </label>
            <label className="flex items-center gap-1.5 text-xs text-text-muted">
              <input
                type="checkbox"
                checked={!!config.includeThreads}
                onChange={(e) => onChange({ ...config, includeThreads: e.target.checked })}
              />
              Include thread replies
            </label>
          </div>
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {personal && (
              <div>
                <label className="block text-xs text-text-muted mb-1">
                  {type === "github" ? "GitHub username" : "Linear name or user id"}
                </label>
                <input
                  type="text"
                  value={identity}
                  onChange={(e) =>
                    onChange({ ...config, [identityKey]: e.target.value.replace(/^@/, "") })
                  }
                  placeholder={type === "github" ? "octocat" : "Ada Lovelace"}
                  aria-invalid={!identity.trim()}
                  className={INPUT_INNER}
                />
                <p className="text-[11px] text-text-muted/60 mt-1">
                  Whose review requests, assignments, and mentions count as “about you”.
                </p>
              </div>
            )}
            {type === "github"
              ? listField("repos", "Only these repos", "owner/name, owner/other")
              : listField("teams", "Only these teams", "ENG, OPS")}
            {type === "linear" && listField("labels", "Only with a label", "bug, triage")}
          </div>
          {type === "linear" && (
            <div>
              <label className="flex items-center gap-1.5 text-xs text-text-muted">
                <input
                  type="checkbox"
                  checked={othersOnly}
                  onChange={(e) => {
                    const next: Record<string, unknown> = { ...config };
                    if (e.target.checked) next.othersOnly = true;
                    else delete next.othersOnly;
                    onChange(next);
                  }}
                />
                Only tickets from someone else
              </label>
              <p className="text-[11px] text-text-muted/60 mt-1 ml-5">
                Skips tickets you created and changes you made yourself, like assigning a ticket to
                yourself.
              </p>
            </div>
          )}
        </>
      )}
      <p className="text-[11px] text-text-muted/80">
        Each firing starts one run — in a pod or on your machine, whichever you pick below — with
        the event's fields available as {"{{param}}"}s.
      </p>
    </div>
  );
}
