import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSsrfSafeUrl, assertSsrfSafe, SsrfError } from "./ssrf.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import * as dns from "node:dns/promises";

const mockLookup = dns.lookup as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockLookup.mockReset();
  // Default: resolve to a public IP so non-rebinding tests pass
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("isSsrfSafeUrl (synchronous)", () => {
  it.each([
    ["https://example.com/webhook", "public HTTPS"],
    ["https://hooks.slack.com/services/T00/B00/xxx", "Slack webhook"],
    ["http://api.github.com/repos", "public HTTP"],
    ["https://1.2.3.4/hook", "public IPv4"],
  ])("allows %s (%s)", (url) => {
    expect(isSsrfSafeUrl(url)).toBe(true);
  });

  it.each([
    ["http://localhost/admin", "localhost"],
    ["http://127.0.0.1/admin", "loopback IPv4"],
    ["http://127.0.0.99/admin", "loopback range"],
    ["http://[::1]/admin", "loopback IPv6"],
    ["http://10.0.0.1/admin", "10.x private"],
    ["http://172.16.5.4/admin", "172.16.x private"],
    ["http://172.31.255.255/x", "172.31.x private"],
    ["http://192.168.1.1/admin", "192.168.x private"],
    ["http://169.254.169.254/latest/meta-data/", "AWS metadata"],
    ["http://100.64.0.1/admin", "carrier-grade NAT"],
    ["http://198.18.0.1/admin", "benchmarking range"],
    ["http://203.0.113.50/admin", "documentation range"],
    ["http://[2001:db8::1]/admin", "IPv6 documentation range"],
    ["http://[2001:0db8::1]/admin", "IPv6 documentation range with leading zero"],
    ["http://my-service.default.svc.cluster.local/api", "K8s internal DNS"],
    ["http://my-service.default.svc.cluster.local./api", "K8s internal DNS trailing dot"],
    ["http://redis.optio.svc.cluster.local:6379", "K8s Redis"],
    ["http://0.0.0.0/x", "unspecified 0.0.0.0"],
    ["ftp://example.com/file", "non-HTTP protocol"],
    ["http://something.internal/x", ".internal TLD"],
    ["http://something.internal./x", ".internal TLD trailing dot"],
    ["http://printer.local/status", ".local hostname"],
    ["http://localhost./admin", "localhost trailing dot"],
  ])("blocks %s (%s)", (url) => {
    expect(isSsrfSafeUrl(url)).toBe(false);
  });

  it("blocks completely invalid URLs", () => {
    expect(isSsrfSafeUrl("not-a-url")).toBe(false);
    expect(isSsrfSafeUrl("")).toBe(false);
  });

  it("allows 172.15.x (outside 172.16/12 block)", () => {
    expect(isSsrfSafeUrl("http://172.15.0.1/x")).toBe(true);
  });

  it("allows 172.32.x (outside 172.16/12 block)", () => {
    expect(isSsrfSafeUrl("http://172.32.0.1/x")).toBe(true);
  });
});

describe("assertSsrfSafe (async with DNS)", () => {
  it("passes for public URLs when DNS resolves to public IP", async () => {
    await expect(assertSsrfSafe("https://example.com/hook")).resolves.toBeUndefined();
  });

  it("throws SsrfError for blocked hostname", async () => {
    await expect(assertSsrfSafe("http://localhost/admin")).rejects.toThrow(SsrfError);
  });

  it("throws SsrfError for private IP literal", async () => {
    await expect(assertSsrfSafe("http://10.0.0.1/admin")).rejects.toThrow(SsrfError);
  });

  it("throws SsrfError for metadata endpoint", async () => {
    await expect(assertSsrfSafe("http://169.254.169.254/latest/meta-data/")).rejects.toThrow(
      SsrfError,
    );
  });

  it("throws SsrfError for K8s internal DNS", async () => {
    await expect(assertSsrfSafe("http://redis.optio.svc.cluster.local:6379")).rejects.toThrow(
      SsrfError,
    );
  });

  it("catches DNS rebinding to loopback", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(assertSsrfSafe("https://evil.example.com/hook")).rejects.toThrow(SsrfError);
    expect(mockLookup).toHaveBeenCalledWith("evil.example.com", { all: true, verbatim: true });
  });

  it("catches DNS rebinding to 169.254.x.x", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(assertSsrfSafe("https://evil.example.com/hook")).rejects.toThrow(SsrfError);
  });

  it("catches DNS rebinding to 10.x.x.x", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(assertSsrfSafe("https://evil.example.com/hook")).rejects.toThrow(SsrfError);
  });

  it("catches DNS rebinding to 192.168.x.x", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "192.168.1.100", family: 4 }]);
    await expect(assertSsrfSafe("https://evil.example.com/hook")).rejects.toThrow(
      /private address/,
    );
  });

  it("checks every DNS answer, not only the first", async () => {
    mockLookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.5", family: 4 },
    ]);

    await expect(assertSsrfSafe("https://mixed.example.com/hook")).rejects.toThrow(SsrfError);
  });

  it("allows DNS resolution to public IP", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }]);
    await expect(assertSsrfSafe("https://good.example.com/hook")).resolves.toBeUndefined();
  });

  it("allows through when DNS lookup fails (NXDOMAIN)", async () => {
    mockLookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    await expect(assertSsrfSafe("https://nonexistent.example.com/hook")).resolves.toBeUndefined();
  });
});
