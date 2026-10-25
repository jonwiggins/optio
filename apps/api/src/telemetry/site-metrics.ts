/**
 * Optio's own metrics for the deployment's monitoring
 * (docs/observability.md "Prometheus endpoint and dashboard"), served next
 * to upstream's (metrics.ts) on the Prometheus endpoint (prometheus.ts), and
 * over OTLP when that is on.
 *
 * Two kinds:
 *
 * - **Gauges read from the database** every 30 s (`site-metrics-snapshot.ts`):
 *   runs by kind and state and the longest wait in `queued` /
 *   `provisioning`, agent pods, credential health (wave 2's
 *   `credential_checks`), ticket providers' consecutive failures, Jira
 *   round-trip writes still to send, remote workspaces still starting, and
 *   this month's spend through the gateway (the usage ledger, every 5 min).
 *   Every API replica reports the same values, so the alert rules and the
 *   dashboard take `max` over them.
 * - **Counters** bumped where a thing happens: a run finishing, a gateway
 *   refusal (the pre-flight's, or the agent's own `API Error: 429`), a
 *   GitLab API error, a failed ticket sync, a refused sign-in, a remote
 *   workspace start that failed, and how long a remote workspace took to
 *   come online (a histogram, by provider). Per replica, so the rules `sum`
 *   them.
 *
 * Labels never carry a person (no user id, name or email), a prompt, an
 * error text or a secret: kinds, states, statuses, hosts, team, workspace
 * and gateway names, models. Every recorder is a no-op until
 * `startSiteMetrics()` — telemetry.ts calls it when metrics are on.
 */
import type { Attributes, Counter, Histogram, Meter, ObservableGauge } from "@opentelemetry/api";
import { metrics as otelMetrics } from "@opentelemetry/api";
import { msUntilOffPeak } from "@optio/shared";
import { logger } from "../logger.js";

/** The fork's series, as Prometheus shows them (counters get `_total`). */
export const SITE_METRICS = {
  runs: "optio_runs",
  runOldestSeconds: "optio_run_oldest_seconds",
  runsFinished: "optio_runs_finished_total",
  agentPods: "optio_agent_pods",
  agentPodOldestProvisioningSeconds: "optio_agent_pod_oldest_provisioning_seconds",
  credentials: "optio_credentials",
  credentialsExpiring: "optio_credentials_expiring",
  ticketProviderFailures: "optio_ticket_provider_consecutive_failures",
  ticketSyncFailures: "optio_ticket_sync_failures_total",
  ticketWritebacksOpen: "optio_ticket_writebacks_open",
  gatewayErrors: "optio_gateway_errors_total",
  gatewaySpendUsd: "optio_gateway_spend_usd",
  gitlabApiErrors: "optio_gitlab_api_errors_total",
  signInFailures: "optio_sign_in_failures_total",
  remoteWorkspacesStarting: "optio_remote_workspaces_starting",
  remoteWorkspaceStartWaitSeconds: "optio_remote_workspace_start_wait_seconds",
  remoteWorkspaceStartSeconds: "optio_remote_workspace_start_seconds",
  remoteWorkspaceStartFailures: "optio_remote_workspace_start_failures_total",
  refreshedAt: "optio_metrics_refreshed_timestamp_seconds",
} as const;

/** Run states that are still going (or waiting on a person): what `optio_runs` counts. */
export const LIVE_RUN_STATES = [
  "pending",
  "waiting_on_deps",
  "queued",
  "provisioning",
  "running",
  "needs_attention",
  "pr_opened",
] as const;
/** The states a run ends in: what `optio_runs_finished_total` counts. */
export const FINISHED_RUN_STATES = ["completed", "failed", "cancelled"] as const;
const RUN_KINDS = ["repo", "standalone"] as const;
const POD_POOLS = ["repo", "standalone", "persistent-agent"] as const;
const POD_STATES = ["provisioning", "ready", "error", "terminating"] as const;
const CREDENTIAL_KINDS = ["gitlab", "gateway", "jira", "remote_workspace"] as const;
const CREDENTIAL_SCOPES = ["organization", "team", "person"] as const;
const CREDENTIAL_STATUSES = ["ok", "warning", "error", "unknown"] as const;

/** What the database says, as of `refreshedAt` (seconds since the epoch; 0 = never). */
export interface SiteSnapshot {
  runs: { kind: string; state: string; count: number; oldestSeconds: number }[];
  agentPods: { pool: string; state: string; count: number; oldestSeconds: number }[];
  credentials: { kind: string; scope: string; status: string; count: number; expiring: number }[];
  ticketProviders: {
    providerId: string;
    source: string;
    host: string;
    enabled: boolean;
    consecutiveFailures: number;
  }[];
  ticketWritebacks: { source: string; status: string; count: number }[];
  /** Remote workspaces Optio started that aren't online yet, by provider. */
  remoteWorkspaces: { provider: string; starting: number; oldestWaitSeconds: number }[];
  spend: { workspace: string; owner: string; team: string; model: string; usd: number }[];
  /** Team id → name, for the counters' `team` label. */
  teams: Record<string, string>;
  refreshedAt: number;
}

export function emptySnapshot(): SiteSnapshot {
  return {
    runs: [],
    agentPods: [],
    credentials: [],
    ticketProviders: [],
    ticketWritebacks: [],
    remoteWorkspaces: [],
    spend: [],
    teams: {},
    refreshedAt: 0,
  };
}

let snapshot: SiteSnapshot = emptySnapshot();

interface Counters {
  runsFinished: Counter;
  gatewayErrors: Counter;
  gitlabApiErrors: Counter;
  ticketSyncFailures: Counter;
  signInFailures: Counter;
  remoteWorkspaceStartFailures: Counter;
  remoteWorkspaceStartSeconds: Histogram;
}
let counters: Counters | null = null;

/** Buckets for how long a remote workspace takes to come online (seconds). */
export const REMOTE_WORKSPACE_START_BUCKETS = [15, 30, 60, 90, 120, 180, 300, 450, 600, 900, 1800];

// ── Labels ────────────────────────────────────────────────────────────────

/** A label value: trimmed, at most `max` characters, "unknown" when empty. */
export function labelValue(v: unknown, max = 80): string {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : "unknown";
}

/** A word-like label (a reason, a provider): lower-case letters, digits, `_ . -`; else "other". */
function wordLabel(v: unknown): string {
  const s = String(v ?? "")
    .trim()
    .toLowerCase();
  return /^[a-z0-9_.-]{1,48}$/.test(s) ? s : "other";
}

/** The host of a URL (no port, no credentials), or "unknown". */
export function hostOf(url: string | null | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).hostname || "unknown";
  } catch {
    return "unknown";
  }
}

// ── Off-peak holds ────────────────────────────────────────────────────────

/**
 * Where the off-peak schedule a repo's "Off-peak only" follows is
 * (@optio/shared `msUntilOffPeak`, what the task worker holds runs by):
 * `peak` while such repos' queued runs are held on purpose, or else when
 * the current off-peak window opened. `optio_run_oldest_seconds{state="queued"}`
 * leaves held runs out, and counts them from the window's opening once it
 * has (the worker stamped them when it held them, hours before).
 */
export interface OffPeakWindow {
  peak: boolean;
  /** When the current off-peak window opened (`now` while `peak`). */
  openedAt: Date;
}

const HOUR_MS = 3_600_000;
let offPeakCache: { hour: number; window: OffPeakWindow } | null = null;

export function offPeakWindow(now: Date = new Date()): OffPeakWindow {
  // Peak starts and ends on the hour (ET's offset is whole hours), so the
  // answer holds for the rest of this UTC hour: the 30 s refresh reuses it.
  const hour = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  if (msUntilOffPeak(now) > 0) return { peak: true, openedAt: now };
  if (offPeakCache?.hour === hour) return offPeakCache.window;
  // Back hour by hour to the one peak ended at (at most a weekend, 66 h).
  let at = hour;
  for (let i = 0; i < 24 * 7 && msUntilOffPeak(new Date(at - 60_000)) === 0; i++) at -= HOUR_MS;
  const window = { peak: false, openedAt: new Date(at) };
  offPeakCache = { hour, window };
  return window;
}

/** Whose work it is, as labels: `owner` (organization / team / person) and the team's name. */
function ownerLabels(o: { ownerTeamId?: string | null; ownerUserId?: string | null }): Attributes {
  if (o.ownerTeamId) {
    return { owner: "team", team: labelValue(snapshot.teams[o.ownerTeamId] ?? o.ownerTeamId) };
  }
  return { owner: o.ownerUserId ? "person" : "organization" };
}

/**
 * The HTTP status a failed run's message says the model gateway answered,
 * or null: Claude Code's `API Error: 429 …`, OpenCode's `statusCode: 401`,
 * or a 401 / 403 / 429 named next to the gateway's own words. Optio's own
 * pre-flight messages ("Your gateway token was rejected …") are left out:
 * the pre-flight counts its refusals where they happen.
 */
export function gatewayStatusOf(message: string | null | undefined): string | null {
  if (!message) return null;
  if (/gateway token (?:is|was|expired)\b/i.test(message)) return null;
  const m =
    message.match(/\bAPI Error:?\s*(\d{3})\b/i) ??
    message.match(/\bstatus(?:_?code)?["']?\s*[:=]\s*(\d{3})\b/i);
  if (m) return Number(m[1]) >= 400 ? m[1] : null;
  const bare = message.match(/\b(401|403|429)\b/);
  if (
    bare &&
    /gateway|litellm|unauthori[sz]ed|forbidden|too many requests|rate.?limit|budget/i.test(message)
  ) {
    return bare[1];
  }
  return null;
}

// ── Registration ──────────────────────────────────────────────────────────

type Observe = (result: { observe(value: number, attrs?: Attributes): void }) => void;

function gauge(meter: Meter, name: string, description: string, observe: Observe, unit?: string) {
  const g: ObservableGauge = meter.createObservableGauge(name, {
    description,
    ...(unit ? { unit } : {}),
  });
  g.addCallback((result) => observe(result));
  return g;
}

/**
 * Make the instruments on `meter` (the API's own by default). The gauges
 * read the last snapshot; the counters start at zero. Exported for tests,
 * which pass a meter of their own.
 */
export function initSiteMetrics(meter: Meter = otelMetrics.getMeter("optio-api")): void {
  counters = {
    runsFinished: meter.createCounter(SITE_METRICS.runsFinished, {
      description:
        "Runs that ended, by kind (repo, standalone) and state (completed, failed, cancelled)",
    }),
    gatewayErrors: meter.createCounter(SITE_METRICS.gatewayErrors, {
      description:
        "Model gateway refusals by HTTP status, model, owner and team; source: the pre-flight or the run",
    }),
    gitlabApiErrors: meter.createCounter(SITE_METRICS.gitlabApiErrors, {
      description: "GitLab API answers that weren't 2xx, by host and status",
    }),
    ticketSyncFailures: meter.createCounter(SITE_METRICS.ticketSyncFailures, {
      description: "Ticket provider syncs that failed, by source (jira, gitlab)",
    }),
    signInFailures: meter.createCounter(SITE_METRICS.signInFailures, {
      description: "Refused sign-ins by provider (oidc, ldap) and reason",
    }),
    remoteWorkspaceStartFailures: meter.createCounter(SITE_METRICS.remoteWorkspaceStartFailures, {
      description:
        "Remote workspaces that failed to start or didn't come online in time, by provider",
    }),
    remoteWorkspaceStartSeconds: meter.createHistogram(SITE_METRICS.remoteWorkspaceStartSeconds, {
      description:
        "How long a remote workspace Optio started took to come online (its daemon's first hello), by provider",
      unit: "s",
      advice: { explicitBucketBoundaries: REMOTE_WORKSPACE_START_BUCKETS },
    }),
  };

  gauge(
    meter,
    SITE_METRICS.runs,
    "Runs by kind and state, for the states a run is still in",
    (r) => {
      const seen = new Map<string, number>();
      for (const row of snapshot.runs) seen.set(`${row.kind}|${row.state}`, row.count);
      for (const kind of kindsOf(
        snapshot.runs.map((x) => x.kind),
        RUN_KINDS,
      )) {
        for (const state of LIVE_RUN_STATES) {
          r.observe(seen.get(`${kind}|${state}`) ?? 0, { kind, state });
        }
      }
    },
  );
  gauge(
    meter,
    SITE_METRICS.runOldestSeconds,
    "How long the longest-waiting run has been queued or provisioning, by kind (0: none)",
    (r) => {
      for (const kind of kindsOf(
        snapshot.runs.map((x) => x.kind),
        RUN_KINDS,
      )) {
        for (const state of ["queued", "provisioning"]) {
          const row = snapshot.runs.find((x) => x.kind === kind && x.state === state);
          r.observe(row ? row.oldestSeconds : 0, { kind, state });
        }
      }
    },
    "s",
  );
  gauge(meter, SITE_METRICS.agentPods, "Agent pods by pool and state", (r) => {
    for (const pool of kindsOf(
      snapshot.agentPods.map((x) => x.pool),
      POD_POOLS,
    )) {
      for (const state of POD_STATES) {
        const row = snapshot.agentPods.find((x) => x.pool === pool && x.state === state);
        r.observe(row?.count ?? 0, { pool, state });
      }
    }
  });
  gauge(
    meter,
    SITE_METRICS.agentPodOldestProvisioningSeconds,
    "How long the oldest agent pod still provisioning has been at it, by pool (0: none)",
    (r) => {
      for (const pool of kindsOf(
        snapshot.agentPods.map((x) => x.pool),
        POD_POOLS,
      )) {
        const row = snapshot.agentPods.find((x) => x.pool === pool && x.state === "provisioning");
        r.observe(row?.oldestSeconds ?? 0, { pool });
      }
    },
    "s",
  );
  gauge(
    meter,
    SITE_METRICS.credentials,
    "Credentials Optio checks (Settings → System health) by kind, scope and status",
    (r) => {
      for (const kind of CREDENTIAL_KINDS) {
        for (const scope of CREDENTIAL_SCOPES) {
          for (const status of CREDENTIAL_STATUSES) {
            const n = snapshot.credentials
              .filter((x) => x.kind === kind && x.scope === scope && x.status === status)
              .reduce((a, x) => a + x.count, 0);
            r.observe(n, { kind, scope, status });
          }
        }
      }
    },
  );
  gauge(
    meter,
    SITE_METRICS.credentialsExpiring,
    "Credentials that expire within 7 days and haven't yet, by kind and scope",
    (r) => {
      for (const kind of CREDENTIAL_KINDS) {
        for (const scope of CREDENTIAL_SCOPES) {
          const n = snapshot.credentials
            .filter((x) => x.kind === kind && x.scope === scope)
            .reduce((a, x) => a + x.expiring, 0);
          r.observe(n, { kind, scope });
        }
      }
    },
  );
  gauge(
    meter,
    SITE_METRICS.ticketProviderFailures,
    "Syncs in a row each ticket provider has failed (5 disables it)",
    (r) => {
      for (const p of snapshot.ticketProviders) {
        r.observe(p.consecutiveFailures, {
          provider_id: p.providerId,
          source: p.source,
          host: p.host,
          enabled: String(p.enabled),
        });
      }
    },
  );
  gauge(
    meter,
    SITE_METRICS.ticketWritebacksOpen,
    "Ticket round-trip writes (comments, links, statuses) not yet sent, by source and status",
    (r) => {
      for (const w of snapshot.ticketWritebacks) {
        r.observe(w.count, { source: w.source, status: w.status });
      }
    },
  );
  gauge(
    meter,
    SITE_METRICS.remoteWorkspacesStarting,
    "Remote workspaces Optio started that aren't online yet, by provider",
    (r) => {
      for (const w of snapshot.remoteWorkspaces) r.observe(w.starting, { provider: w.provider });
    },
  );
  gauge(
    meter,
    SITE_METRICS.remoteWorkspaceStartWaitSeconds,
    "How long the longest-starting remote workspace has been coming up, by provider",
    (r) => {
      for (const w of snapshot.remoteWorkspaces) {
        r.observe(w.oldestWaitSeconds, { provider: w.provider });
      }
    },
    "s",
  );
  gauge(
    meter,
    SITE_METRICS.gatewaySpendUsd,
    "Spend this calendar month (UTC) through the model gateway, priced from its catalog, by workspace, owner, team and model",
    (r) => {
      for (const s of snapshot.spend) {
        r.observe(s.usd, {
          workspace: s.workspace,
          owner: s.owner,
          ...(s.team ? { team: s.team } : {}),
          model: s.model,
        });
      }
    },
    "usd",
  );
  gauge(
    meter,
    SITE_METRICS.refreshedAt,
    "When this API last read the gauges above from its database (seconds since the epoch)",
    (r) => {
      if (snapshot.refreshedAt > 0) r.observe(snapshot.refreshedAt);
    },
    "s",
  );
}

/** The kinds to report: the known ones, plus any the database holds that we don't know. */
function kindsOf(found: string[], known: readonly string[]): string[] {
  return [...new Set([...known, ...found])];
}

// ── Recorders (no-ops until started) ──────────────────────────────────────

/**
 * A run ended (task-service.ts / workflow-service.ts announce it). A failed
 * run whose message says the gateway refused it also counts a gateway error.
 */
export function recordRunFinished(
  kind: string,
  state: string,
  run: {
    errorMessage?: string | null;
    modelUsed?: string | null;
    ownerTeamId?: string | null;
    ownerUserId?: string | null;
  } = {},
): void {
  if (!counters || !(FINISHED_RUN_STATES as readonly string[]).includes(state)) return;
  try {
    counters.runsFinished.add(1, { kind: wordLabel(kind), state });
    if (state === "failed") {
      const status = gatewayStatusOf(run.errorMessage);
      if (status) {
        recordGatewayError({
          status,
          model: run.modelUsed,
          ownerTeamId: run.ownerTeamId,
          ownerUserId: run.ownerUserId,
          source: "run",
        });
      }
    }
  } catch (err) {
    logger.debug({ err }, "site metrics: recordRunFinished failed");
  }
}

/** The gateway refused a run's token or a call: its status, the model, whose work. */
export function recordGatewayError(e: {
  status: number | string;
  model?: string | null;
  ownerTeamId?: string | null;
  ownerUserId?: string | null;
  source: "preflight" | "run";
}): void {
  if (!counters) return;
  counters.gatewayErrors.add(1, {
    status: labelValue(e.status, 3),
    model: labelValue(e.model),
    source: e.source,
    ...ownerLabels(e),
  });
}

/** GitLab answered `status` (not 2xx) to a call to `url`. */
export function recordGitLabApiError(url: string, status: number | string): void {
  if (!counters) return;
  counters.gitlabApiErrors.add(1, { host: hostOf(url), status: labelValue(status, 8) });
}

/** A ticket provider's sync failed (ticket-sync-service.ts). */
export function recordTicketSyncFailure(source: string): void {
  if (!counters) return;
  counters.ticketSyncFailures.add(1, { source: wordLabel(source) });
}

/** A sign-in was refused (audit.ts `auditSignInFailure`). */
export function recordSignInFailure(provider: string, reason: string): void {
  if (!counters) return;
  counters.signInFailures.add(1, { provider: wordLabel(provider), reason: wordLabel(reason) });
}

/** The remote-workspace watcher failed a start: the workspace failed or never came online. */
export function recordRemoteWorkspaceStartFailure(provider: string): void {
  if (!counters) return;
  counters.remoteWorkspaceStartFailures.add(1, { provider });
}

/**
 * A remote workspace Optio started came online after `seconds`
 * (remote-workspace-service.ts `noteRemoteWorkspaceHello`).
 */
export function recordRemoteWorkspaceStarted(provider: string, seconds: number): void {
  if (!counters || !Number.isFinite(seconds) || seconds < 0) return;
  counters.remoteWorkspaceStartSeconds.record(seconds, { provider });
}

/** Whether the recorders above count (metrics are on): callers skip work they'd do only for them. */
export function siteMetricsOn(): boolean {
  return counters !== null;
}

// ── The refresh ───────────────────────────────────────────────────────────

const REFRESH_MS = 30_000;
const SPEND_REFRESH_MS = 5 * 60_000;
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let refreshing: Promise<void> | null = null;
let spendReadAt = 0;
let failing = false;

/**
 * Read the gauges from the database now (one at a time: a scrape storm
 * never multiplies the queries). The spend is read at most every 5 minutes
 * unless `force`.
 */
export function refreshSiteMetrics(opts: { force?: boolean } = {}): Promise<void> {
  refreshing ??= (async () => {
    try {
      const { readSiteSnapshot } = await import("./site-metrics-snapshot.js");
      const withSpend = opts.force || Date.now() - spendReadAt >= SPEND_REFRESH_MS;
      const next = await readSiteSnapshot({ spend: withSpend });
      if (withSpend && next.spendRead) spendReadAt = Date.now();
      // A part that wasn't read (the spend between its reads, a query that
      // failed) keeps its last values rather than dropping to zero, which
      // would clear alerts; OptioMetricsStale says when the reads stop.
      const merged: SiteSnapshot = { ...next.snapshot };
      const keep = <K extends keyof SiteSnapshot>(key: K) => {
        merged[key] = snapshot[key];
      };
      for (const key of next.failed) keep(key);
      if (!next.spendRead) keep("spend");
      if (!merged.refreshedAt) keep("refreshedAt");
      snapshot = merged;
      if (next.failed.length && !failing) {
        logger.warn({ failed: next.failed }, "site metrics: some gauges couldn't be read");
      }
      failing = next.failed.length > 0;
    } catch (err) {
      if (!failing) logger.warn({ err }, "site metrics: the database couldn't be read");
      failing = true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * Turn the fork's metrics on: the instruments, and the database read every
 * 30 s (unref'd: it never holds the process open). Called once metrics are
 * on (telemetry.ts `registerMetricCallbacks`); a second call does nothing.
 */
export function startSiteMetrics(): void {
  if (started) return;
  started = true;
  initSiteMetrics();
  void refreshSiteMetrics({ force: true });
  timer = setInterval(() => void refreshSiteMetrics(), REFRESH_MS);
  timer.unref?.();
}

/** Stop the refresh (tests; shutdown leaves it to the process). */
export function stopSiteMetrics(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

/** The snapshot the gauges read (tests). */
export function siteSnapshot(): SiteSnapshot {
  return snapshot;
}

/** Replace the snapshot (tests). */
export function setSiteSnapshotForTests(next: SiteSnapshot): void {
  snapshot = next;
}
