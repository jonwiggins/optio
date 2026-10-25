import { beforeAll, describe, expect, it, vi } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { readSiteSnapshot } from "./site-metrics-snapshot.js";
import {
  SITE_METRICS,
  emptySnapshot,
  gatewayStatusOf,
  hostOf,
  initSiteMetrics,
  offPeakWindow,
  recordRemoteWorkspaceStartFailure,
  recordRemoteWorkspaceStarted,
  recordGatewayError,
  recordGitLabApiError,
  recordRunFinished,
  recordSignInFailure,
  recordTicketSyncFailure,
  refreshSiteMetrics,
  setSiteSnapshotForTests,
  siteMetricsOn,
  siteSnapshot,
} from "./site-metrics.js";

vi.mock("./site-metrics-snapshot.js", () => ({ readSiteSnapshot: vi.fn() }));

/**
 * The fork's metrics as Prometheus scrapes them: the instruments registered
 * on a real meter provider with the Prometheus reader (its HTTP listener
 * off), serialized as the endpoint serves them.
 */

const exporter = new PrometheusExporter({ preventServerStart: true, withoutScopeInfo: true });
const provider = new MeterProvider({ readers: [exporter] });
const serializer = new PrometheusSerializer(undefined, false, undefined, true, true);

async function scrape(): Promise<string> {
  const { resourceMetrics } = await exporter.collect();
  return serializer.serialize(resourceMetrics);
}

/** The value of the one series of `name` that has every label in `labels`, or undefined. */
function valueOf(
  text: string,
  name: string,
  labels: Record<string, string> = {},
): number | undefined {
  const want = Object.entries(labels).map(([k, v]) => `${k}="${v}"`);
  for (const line of text.split("\n")) {
    if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
    const braces = line.match(/^[^{ ]+(?:\{(.*)\})? (\S+)$/);
    if (!braces) continue;
    const have = (braces[1] ?? "").split(",");
    if (want.every((w) => have.includes(w))) return Number(braces[2]);
  }
  return undefined;
}

const TEAM = "7f6b0a52-6c0c-4d38-9a0f-2b1d3d0b8c11";
const PERSON = "0e0c3a4e-5d7e-4b8e-8e0f-3a9a1c2b4d55";

describe("site metrics before they are on", () => {
  it("records nothing and never throws", () => {
    expect(() => {
      recordRunFinished("repo", "failed", { errorMessage: "API Error: 429" });
      recordGatewayError({ status: 401, source: "preflight" });
      recordGitLabApiError("https://gitlab.example.test/api/v4/projects/1", 500);
      recordTicketSyncFailure("jira");
      recordSignInFailure("ldap", "invalid_credentials");
      recordRemoteWorkspaceStartFailure("coder");
      recordRemoteWorkspaceStarted("coder", 42);
    }).not.toThrow();
    expect(siteMetricsOn()).toBe(false);
  });
});

describe("site metrics on the Prometheus endpoint", () => {
  beforeAll(() => {
    initSiteMetrics(provider.getMeter("optio-api"));
  });

  it("serves the database gauges, zero-filled for the states nothing is in", async () => {
    setSiteSnapshotForTests({
      ...emptySnapshot(),
      runs: [
        { kind: "repo", state: "queued", count: 2, oldestSeconds: 1900 },
        { kind: "standalone", state: "provisioning", count: 1, oldestSeconds: 40 },
      ],
      agentPods: [{ pool: "standalone", state: "provisioning", count: 1, oldestSeconds: 1200 }],
      credentials: [
        { kind: "gitlab", scope: "person", status: "error", count: 1, expiring: 0 },
        { kind: "gateway", scope: "team", status: "warning", count: 2, expiring: 1 },
        { kind: "gateway", scope: "team", status: "ok", count: 3, expiring: 1 },
      ],
      ticketProviders: [
        {
          providerId: "p1",
          source: "jira",
          host: "jira.example.test",
          enabled: true,
          consecutiveFailures: 3,
        },
      ],
      ticketWritebacks: [{ source: "jira", status: "failed", count: 4 }],
      remoteWorkspaces: [{ provider: "coder", starting: 1, oldestWaitSeconds: 300 }],
      spend: [
        { workspace: "acme", owner: "team", team: "Platform", model: "sonnet", usd: 1.5 },
        { workspace: "acme", owner: "person", team: "", model: "sonnet", usd: 0.25 },
      ],
      teams: { [TEAM]: "Platform" },
      refreshedAt: 1_790_000_000,
    });
    const text = await scrape();

    expect(valueOf(text, SITE_METRICS.runs, { kind: "repo", state: "queued" })).toBe(2);
    expect(valueOf(text, SITE_METRICS.runs, { kind: "repo", state: "running" })).toBe(0);
    expect(valueOf(text, SITE_METRICS.runs, { kind: "standalone", state: "provisioning" })).toBe(1);
    expect(valueOf(text, SITE_METRICS.runOldestSeconds, { kind: "repo", state: "queued" })).toBe(
      1900,
    );
    expect(
      valueOf(text, SITE_METRICS.runOldestSeconds, { kind: "repo", state: "provisioning" }),
    ).toBe(0);
    expect(valueOf(text, SITE_METRICS.agentPods, { pool: "repo", state: "ready" })).toBe(0);
    expect(
      valueOf(text, SITE_METRICS.agentPodOldestProvisioningSeconds, { pool: "standalone" }),
    ).toBe(1200);
    expect(
      valueOf(text, SITE_METRICS.credentials, { kind: "gitlab", scope: "person", status: "error" }),
    ).toBe(1);
    expect(
      valueOf(text, SITE_METRICS.credentials, {
        kind: "remote_workspace",
        scope: "organization",
        status: "ok",
      }),
    ).toBe(0);
    expect(
      valueOf(text, SITE_METRICS.credentialsExpiring, { kind: "gateway", scope: "team" }),
    ).toBe(2);
    expect(
      valueOf(text, SITE_METRICS.ticketProviderFailures, {
        provider_id: "p1",
        source: "jira",
        host: "jira.example.test",
        enabled: "true",
      }),
    ).toBe(3);
    expect(
      valueOf(text, SITE_METRICS.ticketWritebacksOpen, { source: "jira", status: "failed" }),
    ).toBe(4);
    expect(valueOf(text, SITE_METRICS.remoteWorkspacesStarting, { provider: "coder" })).toBe(1);
    expect(valueOf(text, SITE_METRICS.remoteWorkspaceStartWaitSeconds, { provider: "coder" })).toBe(
      300,
    );
    expect(
      valueOf(text, SITE_METRICS.gatewaySpendUsd, {
        owner: "team",
        team: "Platform",
        model: "sonnet",
      }),
    ).toBe(1.5);
    // A person's spend carries no team label, and never the person.
    const personLine = text
      .split("\n")
      .find((l) => l.startsWith(SITE_METRICS.gatewaySpendUsd) && l.includes('owner="person"'));
    expect(personLine).toBeDefined();
    expect(personLine).not.toContain("team=");
    expect(valueOf(text, SITE_METRICS.refreshedAt)).toBe(1_790_000_000);
    expect(text).toContain(`# TYPE ${SITE_METRICS.runs} gauge`);
  });

  it("counts runs that end, and a failed run the gateway refused", async () => {
    recordRunFinished("repo", "running");
    recordRunFinished("repo", "completed");
    recordRunFinished("standalone", "failed", {
      errorMessage: 'API Error: 429 {"error":{"message":"Budget has been exceeded"}}',
      modelUsed: "claude-sonnet-internal",
      ownerTeamId: TEAM,
      ownerUserId: PERSON,
    });
    recordRunFinished("repo", "failed", { errorMessage: "exit code 1", ownerUserId: PERSON });
    const text = await scrape();

    expect(valueOf(text, SITE_METRICS.runsFinished, { kind: "repo", state: "completed" })).toBe(1);
    expect(valueOf(text, SITE_METRICS.runsFinished, { kind: "repo", state: "failed" })).toBe(1);
    expect(valueOf(text, SITE_METRICS.runsFinished, { kind: "standalone", state: "failed" })).toBe(
      1,
    );
    expect(valueOf(text, SITE_METRICS.runsFinished, { state: "running" })).toBeUndefined();
    expect(
      valueOf(text, SITE_METRICS.gatewayErrors, {
        status: "429",
        model: "claude-sonnet-internal",
        source: "run",
        owner: "team",
        team: "Platform",
      }),
    ).toBe(1);
    expect(text).toContain(`# TYPE ${SITE_METRICS.runsFinished} counter`);
    expect(text).not.toContain(PERSON);
  });

  it("counts the pre-flight's refusals, GitLab errors, failed syncs, refused sign-ins and remote-workspace starts, and times them", async () => {
    recordGatewayError({ status: 401, model: "sonnet", ownerUserId: PERSON, source: "preflight" });
    recordGatewayError({ status: 401, source: "preflight" });
    recordGitLabApiError(
      "https://gitlab.example.test/api/v4/projects/platform%2Fapp/merge_requests",
      401,
    );
    recordGitLabApiError("not a url", 502);
    recordTicketSyncFailure("jira");
    recordTicketSyncFailure("jira");
    recordSignInFailure("ldap", "invalid_credentials");
    recordSignInFailure("oidc", "Bad <thing> said by the provider");
    recordRemoteWorkspaceStartFailure("coder");
    recordRemoteWorkspaceStarted("coder", 75);
    recordRemoteWorkspaceStarted("coder", 400);
    recordRemoteWorkspaceStarted("coder", -1); // a clock that went back: not a start time
    recordRemoteWorkspaceStarted("coder", Number.NaN);
    const text = await scrape();

    expect(
      valueOf(text, SITE_METRICS.gatewayErrors, {
        status: "401",
        model: "sonnet",
        source: "preflight",
        owner: "person",
      }),
    ).toBe(1);
    expect(
      valueOf(text, SITE_METRICS.gatewayErrors, {
        status: "401",
        model: "unknown",
        owner: "organization",
      }),
    ).toBe(1);
    expect(
      valueOf(text, SITE_METRICS.gitlabApiErrors, { host: "gitlab.example.test", status: "401" }),
    ).toBe(1);
    expect(valueOf(text, SITE_METRICS.gitlabApiErrors, { host: "unknown", status: "502" })).toBe(1);
    // Only the host: never the project path.
    expect(text).not.toContain("platform%2Fapp");
    expect(valueOf(text, SITE_METRICS.ticketSyncFailures, { source: "jira" })).toBe(2);
    expect(
      valueOf(text, SITE_METRICS.signInFailures, {
        provider: "ldap",
        reason: "invalid_credentials",
      }),
    ).toBe(1);
    expect(valueOf(text, SITE_METRICS.signInFailures, { provider: "oidc", reason: "other" })).toBe(
      1,
    );
    expect(valueOf(text, SITE_METRICS.remoteWorkspaceStartFailures, { provider: "coder" })).toBe(1);
    // How long the starts took: a histogram in seconds, buckets up to 30 minutes.
    expect(siteMetricsOn()).toBe(true);
    expect(valueOf(text, `${SITE_METRICS.remoteWorkspaceStartSeconds}_count`)).toBe(2);
    expect(valueOf(text, `${SITE_METRICS.remoteWorkspaceStartSeconds}_sum`)).toBe(475);
    expect(valueOf(text, `${SITE_METRICS.remoteWorkspaceStartSeconds}_bucket`, { le: "60" })).toBe(
      0,
    );
    expect(valueOf(text, `${SITE_METRICS.remoteWorkspaceStartSeconds}_bucket`, { le: "90" })).toBe(
      1,
    );
    expect(valueOf(text, `${SITE_METRICS.remoteWorkspaceStartSeconds}_bucket`, { le: "450" })).toBe(
      2,
    );
    expect(
      valueOf(text, `${SITE_METRICS.remoteWorkspaceStartSeconds}_bucket`, { le: "1800" }),
    ).toBe(2);
    expect(text).not.toContain(PERSON);
  });
});

describe("gatewayStatusOf", () => {
  it("reads the status the agent got from the gateway", () => {
    expect(
      gatewayStatusOf('API Error: 401 {"type":"error","error":{"type":"authentication_error"}}'),
    ).toBe("401");
    expect(gatewayStatusOf("API Error: 429 Budget has been exceeded")).toBe("429");
    expect(gatewayStatusOf("AI_APICallError: Too Many Requests (statusCode: 429)")).toBe("429");
    expect(gatewayStatusOf("LiteLLM answered 403 Forbidden for model sonnet")).toBe("403");
  });

  it("leaves other failures, successes and Optio's own pre-flight messages alone", () => {
    expect(gatewayStatusOf(null)).toBeNull();
    expect(gatewayStatusOf("exit code 1")).toBeNull();
    expect(gatewayStatusOf("API Error: 200 ok")).toBeNull();
    expect(gatewayStatusOf("Processed 429 files")).toBeNull();
    expect(
      gatewayStatusOf(
        "Your gateway token was rejected by the gateway (401: Authentication Error) — put in a new one under Settings → My tokens",
      ),
    ).toBeNull();
    expect(
      gatewayStatusOf("The Platform team's gateway token is over budget (5.10 of 5.00 USD spent)"),
    ).toBeNull();
  });
});

describe("hostOf", () => {
  it("keeps only the host name", () => {
    expect(hostOf("https://user:pw@gitlab.example.test:8443/api/v4")).toBe("gitlab.example.test");
    expect(hostOf("")).toBe("unknown");
    expect(hostOf("::")).toBe("unknown");
  });
});

describe("refreshSiteMetrics", () => {
  it("keeps a part's last values when its read fails, and the spend between its reads", async () => {
    const before = {
      ...emptySnapshot(),
      credentials: [{ kind: "gitlab", scope: "person", status: "error", count: 1, expiring: 0 }],
      spend: [{ workspace: "acme", owner: "team", team: "Platform", model: "sonnet", usd: 2 }],
      refreshedAt: 100,
    };
    setSiteSnapshotForTests(before);
    vi.mocked(readSiteSnapshot).mockResolvedValueOnce({
      snapshot: {
        ...emptySnapshot(),
        runs: [{ kind: "repo", state: "queued", count: 3, oldestSeconds: 5 }],
        refreshedAt: 200,
      },
      spendRead: false,
      failed: ["credentials"],
    });
    await refreshSiteMetrics();
    const now = siteSnapshot();
    expect(now.runs).toEqual([{ kind: "repo", state: "queued", count: 3, oldestSeconds: 5 }]);
    expect(now.credentials).toEqual(before.credentials);
    expect(now.spend).toEqual(before.spend);
    expect(now.refreshedAt).toBe(200);
  });

  it("keeps when it last read the runs when that read fails", async () => {
    setSiteSnapshotForTests({ ...emptySnapshot(), refreshedAt: 300 });
    vi.mocked(readSiteSnapshot).mockResolvedValueOnce({
      snapshot: emptySnapshot(),
      spendRead: true,
      failed: ["runs"],
    });
    await refreshSiteMetrics({ force: true });
    expect(siteSnapshot().refreshedAt).toBe(300);
  });
});

// A repo's "Off-peak only" holds its queued runs on purpose through peak
// hours (8:00-14:00 America/New_York, weekdays: @optio/shared off-peak.ts);
// the oldest-queued gauge leaves them out, then counts from the window's opening.
describe("offPeakWindow", () => {
  it("is peak on a weekday morning in New York", () => {
    const now = new Date("2026-10-21T14:30:00Z"); // Wednesday 10:30 EDT
    expect(offPeakWindow(now)).toEqual({ peak: true, openedAt: now });
  });

  it("opened at 14:00 New York time the same afternoon", () => {
    const w = offPeakWindow(new Date("2026-10-21T19:10:00Z")); // Wednesday 15:10 EDT
    expect(w).toEqual({ peak: false, openedAt: new Date("2026-10-21T18:00:00Z") });
  });

  it("over a weekend, opened on Friday at 14:00 New York time", () => {
    const w = offPeakWindow(new Date("2026-10-25T16:00:00Z")); // Sunday 12:00 EDT
    expect(w).toEqual({ peak: false, openedAt: new Date("2026-10-23T18:00:00Z") });
  });

  it("before Monday's peak, still Friday's window (in winter time too)", () => {
    const w = offPeakWindow(new Date("2026-11-09T12:59:00Z")); // Monday 07:59 EST
    expect(w).toEqual({ peak: false, openedAt: new Date("2026-11-06T19:00:00Z") });
  });
});
