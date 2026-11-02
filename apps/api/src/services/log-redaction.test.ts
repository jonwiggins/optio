import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redis = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    client: {
      set: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
        return "OK";
      }),
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      expire: vi.fn(async () => 1),
    },
  };
});
vi.mock("./event-bus.js", () => ({ getRedisClient: () => redis.client }));

import {
  MIN_SECRET_LENGTH,
  Redactor,
  _resetRunSecretCache,
  isCredentialName,
  redactorForRun,
  registerRunSecrets,
  runSecretValues,
} from "./log-redaction.js";

// Built at run time, so secret scanners don't flag the fixtures.
const TOKEN = ["glpat", "AbCdEfGhIjKlMnOpQrStUv"].join("-");
const AWS_KEY_ID = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

beforeEach(() => {
  process.env.OPTIO_ENCRYPTION_KEY = "a".repeat(64);
  delete process.env.OPTIO_LOG_REDACT_SECRETS;
  delete process.env.OPTIO_LOG_REDACT_PATTERNS;
  redis.store.clear();
  vi.clearAllMocks();
  _resetRunSecretCache();
});

afterEach(() => {
  delete process.env.OPTIO_LOG_REDACT_SECRETS;
  delete process.env.OPTIO_LOG_REDACT_PATTERNS;
});

describe("isCredentialName", () => {
  it.each([
    "GITLAB_TOKEN",
    "GITHUB_TOKEN",
    "ANTHROPIC_API_KEY",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_ACCESS_KEY_ID",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "DB_PASSWORD",
    "OPTIO_CREDENTIAL_SECRET",
    "CLAUDE_VERTEX_SERVICE_ACCOUNT_KEY",
    "openai_api_key",
  ])("%s is a credential", (name) => expect(isCredentialName(name)).toBe(true));

  it.each([
    "OPTIO_JIRA_KEY",
    "CLAUDE_AUTH_MODE",
    "OPTIO_PROMPT",
    "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
    "OPTIO_REPO_URL",
    "ANTHROPIC_BASE_URL",
  ])("%s is not", (name) => expect(isCredentialName(name)).toBe(false));
});

describe("runSecretValues", () => {
  it("takes every secret-store value and the env's credentials, nothing else", () => {
    const values = runSecretValues(
      {
        GITLAB_TOKEN: TOKEN,
        OPTIO_PROMPT: "Fix the flaky test in the payments module",
        OPTIO_REPO_URL: "https://gitlab.example.com/team/repo.git",
        MY_SERVICE: "picked-pod-secret-value",
      },
      [{ MY_SERVICE: "picked-pod-secret-value" }],
    );
    expect([...values]).toEqual([
      ["picked-pod-secret-value", "MY_SERVICE"],
      [TOKEN, "GITLAB_TOKEN"],
    ]);
  });

  it("leaves out short values and Optio's own settings kept as secrets", () => {
    const values = runSecretValues({ GITHUB_TOKEN: "short" }, [
      {
        CLAUDE_AUTH_MODE: "oauth-token",
        AWS_REGION: "eu-central-1",
        GOOGLE_CLOUD_PROJECT: "my-project-123",
        CODEX_APP_SERVER_URL: "http://codex.internal:8080",
        PIN: "1234",
      },
    ]);
    expect(values.size).toBe(0);
    expect("short".length).toBeLessThan(MIN_SECRET_LENGTH);
  });
});

describe("Redactor", () => {
  const values = new Map([
    [TOKEN, "GITLAB_TOKEN"],
    ["p@ss word/with&chars", "DB_PASSWORD"],
  ]);

  it("masks an injected value with its name, everywhere it appears", () => {
    const r = new Redactor(values, false);
    expect(r.redact(`GITLAB_TOKEN=${TOKEN}`)).toBe("GITLAB_TOKEN=[redacted:GITLAB_TOKEN]");
    expect(
      r.redact(`remote: https://oauth2:${TOKEN}@gitlab.example.com/a.git and ${TOKEN} again`),
    ).toBe(
      "remote: https://oauth2:[redacted:GITLAB_TOKEN]@gitlab.example.com/a.git and [redacted:GITLAB_TOKEN] again",
    );
  });

  it("masks the URL-encoded and JSON-escaped forms too", () => {
    const r = new Redactor(new Map([['p@ss "word"/x&y', "DB_PASSWORD"]]), false);
    expect(r.redact("postgres://u:p%40ss%20%22word%22%2Fx%26y@db/x")).toBe(
      "postgres://u:[redacted:DB_PASSWORD]@db/x",
    );
    expect(r.redact('{"password":"p@ss \\"word\\"/x&y"}')).toBe(
      '{"password":"[redacted:DB_PASSWORD]"}',
    );
  });

  it("masks the longer of two overlapping values whole", () => {
    const r = new Redactor(
      new Map([
        ["abcdefgh", "SHORT_TOKEN"],
        ["abcdefgh-ijklmnop", "LONG_TOKEN"],
      ]),
      false,
    );
    expect(r.redact("x abcdefgh-ijklmnop y abcdefgh")).toBe(
      "x [redacted:LONG_TOKEN] y [redacted:SHORT_TOKEN]",
    );
  });

  it("leaves output without a secret byte-for-byte alone", () => {
    const r = new Redactor(values, false);
    const text = "Running tests... 42 passed, glpat- prefix mentioned, ghp_short, Bearer of news";
    expect(r.redact(text)).toBe(text);
  });

  it("masks strings inside metadata, keeping its shape", () => {
    const r = new Redactor(values, false);
    expect(
      r.redactJson({ tool: "Bash", input: { command: `curl -H "PRIVATE-TOKEN: ${TOKEN}"` }, n: 3 }),
    ).toEqual({
      tool: "Bash",
      input: { command: 'curl -H "PRIVATE-TOKEN: [redacted:GITLAB_TOKEN]"' },
      n: 3,
    });
  });

  it("token shapes are masked only with patterns on", () => {
    const gh = "ghp_" + "a1B2".repeat(9);
    const aws = AWS_KEY_ID;
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----";
    const text = `${gh} ${aws} ${jwt} Authorization: Bearer abcdefgh12345678 ${TOKEN}\n${pem}`;
    const off = new Redactor(new Map(), false);
    expect(off.empty).toBe(true);
    expect(off.redact(text)).toBe(text);

    const on = new Redactor(new Map(), true);
    expect(on.redact(text)).toBe(
      "[redacted:github-token] [redacted:aws-access-key] [redacted:jwt] Authorization: Bearer [redacted:bearer] [redacted:gitlab-token]\n[redacted:private-key]",
    );
    // A key block cut off by the end of the line is masked to its end.
    expect(on.redact("key: -----BEGIN PRIVATE KEY-----\nMIIEvQ")).toBe(
      "key: [redacted:private-key]",
    );
  });

  it("an injected value keeps its own name when a pattern would also match it", () => {
    const r = new Redactor(new Map([[TOKEN, "GITLAB_TOKEN"]]), true);
    expect(r.redact(TOKEN)).toBe("[redacted:GITLAB_TOKEN]");
  });

  it("stays fast on a large line", () => {
    const many = new Map<string, string>();
    for (let i = 0; i < 50; i++) many.set(`secret-value-${i}-${"x".repeat(20)}`, `S_${i}_TOKEN`);
    const r = new Redactor(many, true);
    const line = "lorem ipsum dolor sit amet eyJ ghp_ AKIA ".repeat(50_000) + TOKEN; // ~2 MB
    const started = performance.now();
    const out = r.redact(line);
    const elapsed = performance.now() - started;
    expect(out.endsWith("[redacted:gitlab-token]")).toBe(true);
    expect(elapsed).toBeLessThan(2_000);
  });
});

describe("a run's values", () => {
  it("are masked by the instance that registered them and, sealed, by one that did not", async () => {
    await registerRunSecrets("run-1", new Map([[TOKEN, "GITLAB_TOKEN"]]));
    expect((await redactorForRun("run-1"))!.redact(TOKEN)).toBe("[redacted:GITLAB_TOKEN]");

    // What Redis holds is sealed: the value is not in it.
    const [, sealed] = redis.client.set.mock.calls[0];
    expect(sealed).not.toContain(TOKEN);
    expect(sealed).not.toContain("GITLAB_TOKEN");

    // Another instance (nothing cached) reads the sealed copy.
    _resetRunSecretCache();
    expect((await redactorForRun("run-1"))!.redact(`x ${TOKEN}`)).toBe("x [redacted:GITLAB_TOKEN]");
  });

  it("a sealed copy can't be moved to another run", async () => {
    await registerRunSecrets("run-1", new Map([[TOKEN, "GITLAB_TOKEN"]]));
    redis.store.set(
      "optio:run-log-redaction:run-2",
      redis.store.get("optio:run-log-redaction:run-1")!,
    );
    _resetRunSecretCache();
    expect(await redactorForRun("run-2")).toBeNull();
  });

  it("a run with no values has no redactor unless patterns are on", async () => {
    expect(await redactorForRun("run-none")).toBeNull();
    process.env.OPTIO_LOG_REDACT_PATTERNS = "true";
    expect((await redactorForRun("run-none"))!.redact(AWS_KEY_ID)).toBe(
      "[redacted:aws-access-key]",
    );
  });

  it("OPTIO_LOG_REDACT_SECRETS=false keeps nothing and masks nothing", async () => {
    process.env.OPTIO_LOG_REDACT_SECRETS = "false";
    await registerRunSecrets("run-1", new Map([[TOKEN, "GITLAB_TOKEN"]]));
    expect(redis.client.set).not.toHaveBeenCalled();
    expect(await redactorForRun("run-1")).toBeNull();
  });

  it("a Redis failure is logged, not thrown: this instance still masks", async () => {
    redis.client.set.mockRejectedValueOnce(new Error("down"));
    await registerRunSecrets("run-1", new Map([[TOKEN, "GITLAB_TOKEN"]]));
    expect((await redactorForRun("run-1"))!.redact(TOKEN)).toBe("[redacted:GITLAB_TOKEN]");
  });
});
