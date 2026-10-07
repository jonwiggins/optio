import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  assertSsrfSafe,
  classifyAddress,
  decideOutboundHost,
  isSsrfSafeHost,
  isSsrfSafeUrl,
  outboundPolicyFromEnv,
  parseAllowedHosts,
  SsrfError,
  vetOutboundUrl,
  type OutboundPolicy,
} from "./ssrf.js";

vi.mock("node:dns/promises", () => ({
  lookup: vi.fn(),
}));

import * as dns from "node:dns/promises";

const mockLookup = dns.lookup as ReturnType<typeof vi.fn>;

const DEFAULT: OutboundPolicy = { allowPrivate: false, allowedHosts: [], allowAll: false };
const PRIVATE_OK: OutboundPolicy = { ...DEFAULT, allowPrivate: true };
const policyWith = (hosts: string[], allowPrivate = false): OutboundPolicy => ({
  allowPrivate,
  allowedHosts: hosts,
  allowAll: false,
});

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

describe("classifyAddress", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.255", "loopback"],
    ["0.0.0.0", "unspecified"],
    ["169.254.1.1", "link-local"],
    ["169.254.169.254", "metadata"],
    ["100.100.100.200", "metadata"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["240.0.0.1", "reserved"],
    ["192.0.2.10", "reserved"],
    ["198.18.0.1", "reserved"],
    ["203.0.113.50", "reserved"],
    ["10.0.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["172.32.0.1", "public"],
    ["192.168.1.1", "private"],
    ["100.64.0.1", "private"],
    ["93.184.216.34", "public"],
    ["8.8.8.8", "public"],
  ])("IPv4 %s is %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it.each([
    ["::1", "loopback"],
    ["0:0:0:0:0:0:0:1", "loopback"],
    ["::", "unspecified"],
    ["fe80::1", "link-local"],
    ["febf::1", "link-local"],
    ["ff02::1", "multicast"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["fec0::1", "private"],
    ["fd00:ec2::254", "metadata"],
    ["2001:db8::1", "reserved"],
    ["2606:2800:220:1:248:1893:25c8:1946", "public"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["[::ffff:7f00:1]", "loopback"],
    ["::ffff:10.0.0.5", "private"],
    ["::ffff:169.254.169.254", "metadata"],
    ["::ffff:93.184.216.34", "public"],
    ["::10.0.0.5", "private"],
    ["64:ff9b::10.0.0.5", "private"],
    ["64:ff9b::5db8:d822", "public"],
    ["fe80::1%eth0", "link-local"],
  ])("IPv6 %s is %s", (ip, cls) => {
    expect(classifyAddress(ip)).toBe(cls);
  });

  it("returns null for text that is not an address", () => {
    expect(classifyAddress("example.com")).toBeNull();
    expect(classifyAddress("256.1.1.1")).toBeNull();
    expect(classifyAddress("::ffff:300.1.1.1")).toBeNull();
  });
});

describe("isSsrfSafeHost (default policy)", () => {
  it.each([
    ["gitlab.com", "public GitLab"],
    ["gitlab.example.com", "custom GitLab host"],
    ["jira.atlassian.net", "Atlassian host"],
    ["93.184.216.34", "public IPv4 literal"],
    ["[2606:2800:220:1:248:1893:25c8:1946]", "public IPv6 literal"],
  ])("allows %s (%s)", (host) => {
    expect(isSsrfSafeHost(host)).toBe(true);
  });

  it.each([
    ["localhost", "localhost"],
    ["app.localhost", "localhost subdomain"],
    ["127.0.0.1", "loopback IPv4"],
    ["[::1]", "loopback IPv6"],
    ["[::ffff:127.0.0.1]", "IPv4-mapped loopback"],
    ["0.0.0.0", "unspecified"],
    ["169.254.169.254", "AWS / GCP / Azure metadata"],
    ["100.100.100.200", "Alibaba metadata"],
    ["[fd00:ec2::254]", "AWS metadata over IPv6"],
    ["metadata.google.internal", "GCP metadata host name"],
    ["metadata", "bare metadata host name"],
    ["instance-data", "EC2 metadata host name"],
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

describe("isSsrfSafeUrl", () => {
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

  it.each([
    ["http://2130706433/", "decimal 127.0.0.1"],
    ["http://0x7f000001/", "hex 127.0.0.1"],
    ["http://0177.0.0.1/", "octal first octet"],
    ["http://127.1/", "short-form 127.0.0.1"],
    ["http://0xa.0.0.1/", "hex 10.0.0.1"],
    ["http://[::ffff:7f00:1]/", "mapped loopback, hex form"],
    ["http://[0:0:0:0:0:ffff:127.0.0.1]/", "mapped loopback, long form"],
  ])("catches %s (%s) after URL normalisation", (url) => {
    expect(isSsrfSafeUrl(url)).toBe(false);
  });

  it("rejects non-http(s) schemes and unparseable text", () => {
    expect(isSsrfSafeUrl("ftp://example.com/")).toBe(false);
    expect(isSsrfSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSsrfSafeUrl("not a url")).toBe(false);
  });

  it("ignores userinfo when judging the host", () => {
    expect(isSsrfSafeUrl("https://admin:secret@api.example.com/")).toBe(true);
    expect(isSsrfSafeUrl("https://api.example.com@127.0.0.1/")).toBe(false);
  });
});

describe("policy: allowPrivate", () => {
  it("allows private ranges and internal names, never loopback or metadata", () => {
    expect(isSsrfSafeUrl("http://10.0.0.5/", PRIVATE_OK)).toBe(true);
    expect(isSsrfSafeUrl("http://192.168.1.1/", PRIVATE_OK)).toBe(true);
    expect(isSsrfSafeUrl("http://[fd12::1]/", PRIVATE_OK)).toBe(true);
    expect(isSsrfSafeUrl("http://svc.default.svc.cluster.local/", PRIVATE_OK)).toBe(true);
    expect(isSsrfSafeUrl("http://redis.internal/", PRIVATE_OK)).toBe(true);

    expect(isSsrfSafeUrl("http://127.0.0.1/", PRIVATE_OK)).toBe(false);
    expect(isSsrfSafeUrl("http://localhost/", PRIVATE_OK)).toBe(false);
    expect(isSsrfSafeUrl("http://169.254.169.254/", PRIVATE_OK)).toBe(false);
    expect(isSsrfSafeUrl("http://[fd00:ec2::254]/", PRIVATE_OK)).toBe(false);
    expect(isSsrfSafeUrl("http://metadata.google.internal/", PRIVATE_OK)).toBe(false);
    expect(isSsrfSafeUrl("http://100.100.100.200/", PRIVATE_OK)).toBe(false);
    expect(isSsrfSafeUrl("http://192.0.2.1/", PRIVATE_OK)).toBe(false);
  });

  it("applies to resolved addresses too", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    await expect(
      vetOutboundUrl("https://api.corp.example/", { policy: PRIVATE_OK }),
    ).resolves.toMatchObject({ addresses: [{ address: "10.0.0.5", family: 4 }] });
    mockLookup.mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      vetOutboundUrl("https://api.corp.example/", { policy: PRIVATE_OK }),
    ).rejects.toThrow(
      /blocked: api\.corp\.example resolves to a loopback address \(127\.0\.0\.1\); list it in OPTIO_OUTBOUND_ALLOWED_HOSTS/,
    );
  });
});

describe("policy: allowedHosts", () => {
  it("parses comma- and whitespace-separated entries, case-insensitively", () => {
    expect(parseAllowedHosts(" Vault.Internal, 10.0.0.0/8  *.svc.cluster.local\n[::1]")).toEqual([
      "vault.internal",
      "10.0.0.0/8",
      "*.svc.cluster.local",
      "::1",
    ]);
  });

  it("matches an exact host name, loopback included", () => {
    const policy = policyWith(["localhost", "vault.internal"]);
    expect(isSsrfSafeUrl("http://localhost:8200/", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://LOCALHOST./", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://vault.internal/", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://other.internal/", policy)).toBe(false);
  });

  it("matches a *.suffix wildcard but not the bare suffix", () => {
    const policy = policyWith(["*.svc.cluster.local"]);
    expect(isSsrfSafeUrl("http://api.default.svc.cluster.local/", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://svc.cluster.local/", policy)).toBe(false);
  });

  it("matches IP literals and CIDRs against the URL host and against resolved answers", async () => {
    const policy = policyWith(["127.0.0.1", "10.1.0.0/16", "fd12::/16"]);
    expect(isSsrfSafeUrl("http://127.0.0.1:9000/", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://127.0.0.2/", policy)).toBe(false);
    expect(isSsrfSafeUrl("http://10.1.200.3/", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://10.2.0.1/", policy)).toBe(false);
    expect(isSsrfSafeUrl("http://[fd12:1::1]/", policy)).toBe(true);
    expect(isSsrfSafeUrl("http://[fd13::1]/", policy)).toBe(false);

    mockLookup.mockResolvedValueOnce([{ address: "10.1.3.4", family: 4 }]);
    await expect(vetOutboundUrl("https://db.corp.example/", { policy })).resolves.toMatchObject({
      hostname: "db.corp.example",
    });
    mockLookup.mockResolvedValueOnce([{ address: "10.2.3.4", family: 4 }]);
    await expect(vetOutboundUrl("https://db.corp.example/", { policy })).rejects.toThrow(
      /resolves to a private address \(10\.2\.3\.4\); set OPTIO_OUTBOUND_ALLOW_PRIVATE=true/,
    );
  });

  it("an allowlisted host name is allowed whatever it resolves to", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    await expect(
      vetOutboundUrl("http://imds-proxy.example/", { policy: policyWith(["imds-proxy.example"]) }),
    ).resolves.toMatchObject({ addresses: [{ address: "169.254.169.254", family: 4 }] });
  });

  it("a listed metadata host name is allowed only when listed", () => {
    expect(isSsrfSafeUrl("http://metadata.google.internal/", DEFAULT)).toBe(false);
    expect(isSsrfSafeUrl("http://metadata.google.internal/", PRIVATE_OK)).toBe(false);
    expect(
      isSsrfSafeUrl("http://metadata.google.internal/", policyWith(["metadata.google.internal"])),
    ).toBe(true);
  });
});

describe("outboundPolicyFromEnv", () => {
  it("reads the three variables", () => {
    expect(outboundPolicyFromEnv({})).toEqual({
      allowPrivate: false,
      allowedHosts: [],
      allowAll: false,
    });
    expect(
      outboundPolicyFromEnv({
        OPTIO_OUTBOUND_ALLOW_PRIVATE: "true",
        OPTIO_OUTBOUND_ALLOWED_HOSTS: "a.example, 10.0.0.0/8",
      }),
    ).toEqual({ allowPrivate: true, allowedHosts: ["a.example", "10.0.0.0/8"], allowAll: false });
    expect(outboundPolicyFromEnv({ OPTIO_OUTBOUND_ALLOW_PRIVATE: "0" }).allowPrivate).toBe(false);
    expect(outboundPolicyFromEnv({ OPTIO_ALLOW_PRIVATE_URLS: "1" }).allowAll).toBe(true);
    expect(outboundPolicyFromEnv({ OPTIO_ALLOW_PRIVATE_URLS: "true" }).allowAll).toBe(false);
  });

  it("OPTIO_ALLOW_PRIVATE_URLS=1 disables the guard", () => {
    const off = outboundPolicyFromEnv({ OPTIO_ALLOW_PRIVATE_URLS: "1" });
    expect(isSsrfSafeUrl("http://127.0.0.1/", off)).toBe(true);
    expect(isSsrfSafeUrl("http://169.254.169.254/", off)).toBe(true);
  });
});

describe("decideOutboundHost messages", () => {
  it("name the host and the address class, with the right hint", () => {
    expect(decideOutboundHost("10.0.0.5", null, DEFAULT).reason).toBe(
      "blocked: 10.0.0.5 is a private address; set OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS",
    );
    expect(decideOutboundHost("169.254.169.254", null, DEFAULT).reason).toBe(
      "blocked: 169.254.169.254 is a cloud metadata address; list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it",
    );
    expect(decideOutboundHost("metadata.google.internal", null, DEFAULT).reason).toBe(
      "blocked: metadata.google.internal is a cloud metadata host name; list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it",
    );
    expect(decideOutboundHost("redis.internal", null, DEFAULT).reason).toBe(
      "blocked: redis.internal is a private host name; set OPTIO_OUTBOUND_ALLOW_PRIVATE=true or list it in OPTIO_OUTBOUND_ALLOWED_HOSTS",
    );
    expect(
      decideOutboundHost("api.example.com", [{ address: "::1", family: 6 }], DEFAULT).reason,
    ).toBe(
      "blocked: api.example.com resolves to a loopback address (::1); list it in OPTIO_OUTBOUND_ALLOWED_HOSTS to allow it",
    );
  });
});

describe("vetOutboundUrl / assertSsrfSafe — DNS", () => {
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

  it("catches an IPv4-mapped or NAT64 answer hiding an internal address", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "::ffff:127.0.0.1", family: 6 }]);
    await expect(assertSsrfSafe("https://mapped.example.com/")).rejects.toThrow(/loopback/);
    mockLookup.mockResolvedValueOnce([{ address: "64:ff9b::a00:5", family: 6 }]);
    await expect(assertSsrfSafe("https://nat64.example.com/")).rejects.toThrow(/private/);
  });

  it("allows legitimate provider hosts and returns their addresses", async () => {
    mockLookup.mockResolvedValueOnce([{ address: "185.199.108.153", family: 4 }]);
    await expect(
      assertSsrfSafe("https://mycompany.atlassian.net/rest/api/3"),
    ).resolves.toBeUndefined();
    mockLookup.mockResolvedValueOnce([
      { address: "185.199.108.153", family: 4 },
      { address: "2606:50c0:8000::153", family: 6 },
    ]);
    await expect(vetOutboundUrl("https://mycompany.atlassian.net/")).resolves.toEqual({
      url: new URL("https://mycompany.atlassian.net/"),
      hostname: "mycompany.atlassian.net",
      addresses: [
        { address: "185.199.108.153", family: 4 },
        { address: "2606:50c0:8000::153", family: 6 },
      ],
    });
  });

  it("does not resolve IP literals and keeps the literal as the address", async () => {
    await expect(vetOutboundUrl("http://93.184.216.34:8080/x")).resolves.toMatchObject({
      hostname: "93.184.216.34",
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("uses an injected resolver instead of DNS", async () => {
    const resolveHost = vi.fn().mockResolvedValue([{ address: "10.9.9.9", family: 4 }]);
    await expect(vetOutboundUrl("https://api.example.com/", { resolveHost })).rejects.toThrow(
      /resolves to a private address \(10\.9\.9\.9\)/,
    );
    expect(resolveHost).toHaveBeenCalledWith("api.example.com");
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("vetOutboundUrl fails readably when the host does not resolve; assertSsrfSafe lets the fetch fail on its own", async () => {
    mockLookup.mockRejectedValueOnce(
      Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    );
    await expect(vetOutboundUrl("https://nope.example.com/")).rejects.toThrow(
      "nope.example.com could not be resolved (ENOTFOUND)",
    );
    mockLookup.mockRejectedValueOnce(new Error("getaddrinfo ENOTFOUND"));
    await expect(assertSsrfSafe("https://nope.example.com/")).resolves.toBeUndefined();
  });

  it("rejects non-http(s) URLs before resolving", async () => {
    await expect(vetOutboundUrl("ftp://files.example.com/")).rejects.toThrow(
      "blocked: only http and https URLs can be fetched",
    );
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("honours an abort signal while resolving", async () => {
    mockLookup.mockImplementationOnce(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = vetOutboundUrl("https://slow.example.com/", { signal: controller.signal });
    controller.abort(new Error("gave up"));
    await expect(pending).rejects.toThrow("slow.example.com could not be resolved (Error)");
  });
});
