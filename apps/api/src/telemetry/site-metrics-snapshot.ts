/**
 * What the site metrics' gauges read from the database
 * (site-metrics.ts, docs/observability.md "Prometheus endpoint and
 * dashboard"). Each read is its own query, so a table that fails leaves the
 * others' values fresh;
 * every query is a grouped count over an indexed column or a small table,
 * run every 30 s per API replica. The spend (the usage ledger) is the one
 * that grows: read every 5 minutes, this month only, through the ledger's
 * (workspace, time) index.
 */
import { type SQL, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  LIVE_RUN_STATES,
  emptySnapshot,
  hostOf,
  labelValue,
  offPeakWindow,
  type OffPeakWindow,
  type SiteSnapshot,
} from "./site-metrics.js";

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// As the column's enum, not text: a cast on `state` would keep Postgres off
// the (kind, state) index and read every run ever made, every 30 s.
const liveStates = sql.join(
  LIVE_RUN_STATES.map((s) => sql`${s}::task_state`),
  sql`, `,
);

/**
 * Runs by kind and state, with how long the oldest has been in it (by
 * `updated_at`). A queued run a repo's "Off-peak only" holds isn't waiting
 * on Optio: left out of the oldest during peak hours, and counted from the
 * off-peak window's opening after (the worker stamped it when it held it).
 * Exported for the test that checks the plan uses the index.
 */
export function runsQuery(hold: OffPeakWindow): SQL {
  return sql`
    SELECT t.kind, t.state::text AS state, count(*) AS count,
      COALESCE(EXTRACT(EPOCH FROM (now() - min(
        CASE WHEN t.state = 'queued' AND NOT t.ignore_off_peak AND EXISTS (
            SELECT 1 FROM repos r
            WHERE r.repo_url = t.repo_url AND r.off_peak_only
              AND r.workspace_id IS NOT DISTINCT FROM t.workspace_id)
          THEN CASE WHEN ${hold.peak} THEN NULL
            ELSE GREATEST(t.updated_at, ${hold.openedAt.toISOString()}::timestamptz) END
          ELSE t.updated_at END))), 0) AS oldest
    FROM tasks t
    WHERE t.state IN (${liveStates})
    GROUP BY t.kind, t.state`;
}

async function readRuns(hold: OffPeakWindow): Promise<SiteSnapshot["runs"]> {
  const rows = await db.execute<{ kind: string; state: string; count: string; oldest: string }>(
    runsQuery(hold),
  );
  return rows.map((r) => ({
    kind: labelValue(r.kind),
    state: r.state,
    count: num(r.count),
    oldestSeconds: Math.max(0, Math.round(num(r.oldest))),
  }));
}

async function readAgentPods(): Promise<SiteSnapshot["agentPods"]> {
  const rows = await db.execute<{ pool: string; state: string; count: string; oldest: string }>(sql`
    SELECT pool, state::text AS state, count(*) AS count,
      COALESCE(EXTRACT(EPOCH FROM (now() - min(updated_at))), 0) AS oldest
    FROM agent_pods
    GROUP BY pool, state`);
  return rows.map((r) => ({
    pool: labelValue(r.pool),
    state: r.state,
    count: num(r.count),
    oldestSeconds: Math.max(0, Math.round(num(r.oldest))),
  }));
}

/** Credential health (wave 2): rows by kind, scope and status, and those expiring within 7 days. */
async function readCredentials(): Promise<SiteSnapshot["credentials"]> {
  const rows = await db.execute<{
    kind: string;
    scope: string;
    status: string;
    count: string;
    expiring: string;
  }>(sql`
    SELECT kind, scope, status, count(*) AS count,
      count(*) FILTER (WHERE expires_at > now() AND expires_at <= now() + interval '7 days') AS expiring
    FROM credential_checks
    GROUP BY kind, scope, status`);
  return rows.map((r) => ({
    kind: r.kind,
    scope: r.scope,
    status: r.status,
    count: num(r.count),
    expiring: num(r.expiring),
  }));
}

async function readTicketProviders(): Promise<SiteSnapshot["ticketProviders"]> {
  const rows = await db.execute<{
    id: string;
    source: string;
    enabled: boolean;
    failures: number;
    url: string | null;
  }>(sql`
    SELECT id, source, enabled, consecutive_failures AS failures,
      COALESCE(config->>'baseUrl', config->>'url', config->>'host') AS url
    FROM ticket_providers`);
  return rows.map((r) => ({
    providerId: r.id,
    source: labelValue(r.source),
    // A bare host name (GitLab's `host`) has no scheme: read it as one.
    host: r.url ? hostOf(/^[a-z]+:\/\//i.test(r.url) ? r.url : `https://${r.url}`) : "unknown",
    enabled: !!r.enabled,
    consecutiveFailures: num(r.failures),
  }));
}

/** The Jira round trip's writes still to send (wave 3: `pending`, `failed` awaiting a retry). */
async function readTicketWritebacks(): Promise<SiteSnapshot["ticketWritebacks"]> {
  const rows = await db.execute<{ source: string; status: string; count: string }>(sql`
    SELECT ticket_source AS source, status, count(*) AS count
    FROM ticket_writebacks
    WHERE status IN ('pending', 'failed')
    GROUP BY ticket_source, status`);
  return rows.map((r) => ({ source: labelValue(r.source), status: r.status, count: num(r.count) }));
}

/**
 * Remote workspaces Optio started whose daemon hasn't said hello with the
 * pairing token yet, by provider (remote-workspace-service.ts
 * `sweepStartingRemoteWorkspaces` reads the same).
 */
async function readRemoteWorkspaces(): Promise<SiteSnapshot["remoteWorkspaces"]> {
  const rows = await db.execute<{ provider: string; starting: string; oldest: string }>(sql`
    SELECT h.origin AS provider, count(*) AS starting,
      COALESCE(EXTRACT(EPOCH FROM (now() - min(k.created_at))), 0) AS oldest
    FROM local_hosts h
    JOIN api_keys k ON k.id = h.pairing_token_id
    WHERE h.origin <> 'machine' AND k.revoked_at IS NULL
      AND (h.last_seen_at IS NULL OR h.last_seen_at < k.created_at)
    GROUP BY h.origin`);
  return rows.map((row) => ({
    provider: labelValue(row.provider),
    starting: num(row.starting),
    oldestWaitSeconds: Math.max(0, Math.round(num(row.oldest))),
  }));
}

async function readTeams(): Promise<SiteSnapshot["teams"]> {
  const rows = await db.execute<{ id: string; name: string }>(sql`SELECT id, name FROM teams`);
  return Object.fromEntries(rows.map((r) => [r.id, r.name]));
}

/**
 * This calendar month's (UTC) priced spend from the usage ledger, by
 * workspace, whose work it was (a team's, a person's, the organization's;
 * the team as usage's Teams panel finds it: the run's or the agent's
 * `owner_team_id`) and model. With OPTIO_MODEL_ACCESS=gateway every model
 * call goes through the gateway, so this is the gateway's spend as Optio prices it.
 */
async function readSpend(): Promise<SiteSnapshot["spend"]> {
  const rows = await db.execute<{
    workspace: string;
    owner: string;
    team: string | null;
    model: string;
    usd: string;
  }>(sql`
    SELECT w.slug AS workspace, x.owner, t.name AS team, x.model, SUM(x.cost_usd) AS usd
    FROM (
      SELECT l.workspace_id, l.cost_usd,
        COALESCE(NULLIF(l.model, ''), 'unknown') AS model,
        tm.team_id,
        CASE WHEN tm.team_id IS NOT NULL THEN 'team'
             WHEN l.owner_user_id IS NOT NULL THEN 'person'
             ELSE 'organization' END AS owner
      FROM usage_ledger l
      CROSS JOIN LATERAL (SELECT CASE l.source_kind
          WHEN 'tasks' THEN (SELECT r.owner_team_id FROM tasks r WHERE r.id = l.source_id)
          WHEN 'persistent_agent_turns' THEN (SELECT a.owner_team_id FROM persistent_agents a WHERE a.id = l.work_id)
        END AS team_id) tm
      WHERE l.workspace_id IN (SELECT id FROM workspaces)
        AND l.occurred_at >= (date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
        AND l.cost_usd IS NOT NULL
    ) x
    JOIN workspaces w ON w.id = x.workspace_id
    LEFT JOIN teams t ON t.id = x.team_id
    GROUP BY w.slug, x.owner, t.name, x.model`);
  return rows.map((r) => ({
    workspace: labelValue(r.workspace),
    owner: r.owner,
    team: r.team ? labelValue(r.team) : "",
    model: labelValue(r.model),
    usd: Math.round(num(r.usd) * 1e6) / 1e6,
  }));
}

export interface SiteSnapshotRead {
  snapshot: SiteSnapshot;
  /** Whether the spend was read (asked for, and the ledger answered). */
  spendRead: boolean;
  /** The reads that failed: the caller keeps those parts' last values. */
  failed: (keyof SiteSnapshot)[];
}

/**
 * Every gauge's values, now. `refreshedAt` is set when the runs were read
 * (the gauge the alert on a stale API goes by); a read that fails leaves
 * its part empty and is named in `failed`.
 */
export async function readSiteSnapshot(opts: {
  spend: boolean;
  /** Where the off-peak schedule is (tests); `offPeakWindow()` by default. */
  offPeak?: OffPeakWindow;
}): Promise<SiteSnapshotRead> {
  const snap = emptySnapshot();
  const failed: (keyof SiteSnapshot)[] = [];
  const read = async <K extends keyof SiteSnapshot>(
    key: K,
    fn: () => Promise<SiteSnapshot[K]>,
  ): Promise<boolean> => {
    try {
      snap[key] = await fn();
      return true;
    } catch {
      failed.push(key);
      return false;
    }
  };
  const hold = opts.offPeak ?? offPeakWindow();
  const runsRead = await read("runs", () => readRuns(hold));
  await read("agentPods", readAgentPods);
  await read("credentials", readCredentials);
  await read("ticketProviders", readTicketProviders);
  await read("ticketWritebacks", readTicketWritebacks);
  await read("remoteWorkspaces", readRemoteWorkspaces);
  await read("teams", readTeams);
  const spendRead = opts.spend ? await read("spend", readSpend) : false;
  if (runsRead) snap.refreshedAt = Math.floor(Date.now() / 1000);
  return { snapshot: snap, spendRead, failed };
}
