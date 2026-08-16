import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSsrfSafeUrl, isSsrfSafeHost, assertSsrfSafe, SsrfError } from "./ssrf.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import * as dns from "node:dns/promises";

const mockLookup = dns.lookup as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("isSsrfSafeHost", () => {
  it.each([
    ["gitlab.com", "public GitLab"],
    ["gitlab.example.com", "custom GitLab host"],
    ["jira.atlassian.net", "Atlassian host"],
  ])("allows %s (%s)", (host) => {
    expect(isSsrfSafeHost(host)).toBe(true);
  });

  it.each([
    ["localhost", "localhost"],
    ["127.0.0.1", "loopback IPv4"],
    ["169.254.169.254", "AWS metadata"],
    ["10.0.0.1", "private 10.x"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["192.168.1.1", "private 192.168.x"],
    ["198.18.0.1", "benchmarking range"],
    ["203.0.113.50", "documentation range"],
    ["kubernetes.default.svc.cluster.local", "K8s internal DNS"],
    ["kubernetes.default.svc.cluster.local.", "K8s internal DNS with trailing dot"],
    ["redis.internal", ".internal TLD"],
    ["redis.internal.", ".internal TLD with trailing dot"],
    ["printer.local", ".local hostname"],
    ["localhost.", "localhost with trailing dot"],
  ])("blocks %s (%s)", (host) => {
    expect(isSsrfSafeHost(host)).toBe(false);
  });
});

describe("isSsrfSafeUrl — Jira baseUrl scenarios", () => {
  it("allows legitimate Atlassian URLs", () => {
    expect(isSsrfSafeUrl("https://mycompany.atlassian.net")).toBe(true);
  });

  it("blocks cloud metadata service URL", () => {
    expect(isSsrfSafeUrl("http://169.254.169.254/latest/meta-data/iam/security-credentials/")).toBe(
      false,
    );
  });

  it("blocks K8s internal service URL", () => {
    expect(isSsrfSafeUrl("http://kubernetes.default.svc.cluster.local/")).toBe(false);
  });

  it("blocks private network URLs", () => {
    expect(isSsrfSafeUrl("http://10.0.0.5:8080/jira")).toBe(false);
    expect(isSsrfSafeUrl("http://192.168.1.100/jira")).toBe(false);
  });
});

describe("assertSsrfSafe — DNS rebinding for provider hosts", () => {
  it("catches DNS rebinding of Jira baseUrl to metadata service", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertSsrfSafe("https://evil-jira.example.com/")).rejects.toThrow(SsrfError);
  });

  it("catches DNS rebinding of GitLab host to private network", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertSsrfSafe("https://evil-gitlab.example.com/api/v4")).rejects.toThrow(
      SsrfError,
    );
  });

  it("checks every DNS answer, not only the first", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(assertSsrfSafe("https://mixed.example.com/hook")).rejects.toThrow(SsrfError);
  });

  it("allows legitimate provider hosts", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "185.199.108.153", family: 4 }]);
    await expect(
      assertSsrfSafe("https://mycompany.atlassian.net/rest/api/3"),
    ).resolves.toBeUndefined();
  });
});
