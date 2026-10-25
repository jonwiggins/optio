import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyError } from "./error-classifier.js";
import { classifySiteError } from "./error-classifier-site.js";

/**
 * A gateway-only deployment's failure messages (error-classifier-site.ts,
 * OPTIO_MODEL_ACCESS=gateway): they name this Optio's fix; with the default
 * model access upstream's classifier answers as before. Nothing with
 * gateway-only access may send people to the Claude Keychain,
 * `claude setup-token` or "API key auth".
 */

const FORBIDDEN = /Keychain|setup-token|switch to API key|Max subscription/i;

function standard(message: string) {
  vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
  const result = classifyError(message);
  expect(result.remedy).not.toMatch(FORBIDDEN);
  expect(result.description).not.toMatch(FORBIDDEN);
  return result;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("gateway budget (LiteLLM)", () => {
  it("maps LiteLLM's budget_exceeded to 'Gateway budget used up' with the spend", () => {
    const r = standard(
      'API Error: 400 {"error":{"message":"Budget has been exceeded! Current cost: 5.0123, Max budget: 5.0","type":"budget_exceeded","param":null,"code":"400"}}',
    );
    expect(r.title).toBe("Gateway budget used up");
    expect(r.description).toContain("5.0123 of 5.0 USD");
    expect(r.remedy).toContain("Settings → My tokens");
    expect(r.remedy).toContain("Teams → the team → Tokens");
    expect(r.retryable).toBe(false);
  });

  it("knows the exception names too", () => {
    expect(standard("litellm.BudgetExceededError: ExceededTokenBudget for key").title).toBe(
      "Gateway budget used up",
    );
    expect(standard("ExceededBudget: team over").title).toBe("Gateway budget used up");
  });

  it("follows the pre-flight's own message: the team, its name and the reset", () => {
    const r = standard(
      "The Platform team's gateway token is over budget until 2026-11-01 00:00 UTC (5.10 of 5.00 USD spent) — Teams → Platform → Tokens",
    );
    expect(r.title).toBe("Gateway budget used up");
    expect(r.description).toContain("It resets 2026-11-01 00:00 UTC.");
    expect(r.remedy).toContain("Teams → Platform → Tokens");
    expect(r.remedy).not.toContain("Settings → My tokens");
  });

  it("a person's own token points at My tokens", () => {
    const r = standard(
      "Your gateway token is over budget until 2026-11-01 00:00 UTC (1.00 of 0.50 USD spent) — Settings → My tokens",
    );
    expect(r.remedy).toContain("Yours is under Settings → My tokens");
  });
});

describe("gateway token", () => {
  it("maps a LiteLLM 401 to 'Gateway token rejected', not the Keychain", () => {
    const r = standard(
      'API Error: 401 {"error":{"message":"Authentication Error, Invalid proxy server token passed. Received API Key = sk-...abcd","type":"auth_error","param":"None","code":"401"}}',
    );
    expect(r.title).toBe("Gateway token rejected");
    expect(r.remedy).toContain("System health");
  });

  it("an expired LiteLLM key, Claude Code's own 401 text and the pre-flight's are rejections", () => {
    expect(standard("Authentication Error - Expired Key. Key Expiry time 2026-10-01").title).toBe(
      "Gateway token rejected",
    );
    expect(standard("Invalid API key · Please run /login").title).toBe("Gateway token rejected");
    expect(
      standard(
        "Your gateway token was rejected by the gateway (401) — put in a new one under Settings → My tokens",
      ).title,
    ).toBe("Gateway token rejected");
  });

  it("the token-missing messages say where to add it", () => {
    const team = standard(
      "This team has no gateway token yet — a team admin adds one under Teams → Platform → Tokens",
    );
    expect(team.title).toBe("Gateway token missing");
    expect(team.remedy).toContain("Teams → Platform → Tokens");
    const mine = standard("Add your gateway token under Settings → My tokens");
    expect(mine.remedy).toContain("Settings → My tokens");
    const org = standard(
      "The organization has no gateway token — an admin adds one under Settings → Model gateway",
    );
    expect(org.remedy).toContain("Settings → Model gateway");
  });

  it("upstream's 'token expired' sign-in rule becomes the gateway's, with no Keychain", () => {
    const r = standard("OAuth token has expired");
    expect(r.title).toBe("Gateway sign-in failed");
    expect(standard("401 authentication_error").title).toBe("Gateway sign-in failed");
  });

  it("leaves a missing or undecryptable secret to upstream's rules", () => {
    expect(standard("Secret not found: ANTHROPIC_API_KEY (scope: global)").title).toBe(
      "Missing secret: ANTHROPIC_API_KEY",
    );
    expect(standard('Failed to decrypt stored secret "ANTHROPIC_AUTH_TOKEN"').title).toBe(
      "Cannot decrypt secret: ANTHROPIC_AUTH_TOKEN",
    );
  });

  it("a model the gateway doesn't serve", () => {
    const r = standard(
      "litellm.BadRequestError: Invalid model name passed in model=claude-opus-4. Call `/v1/models` to view available models",
    );
    expect(r.title).toBe("Model not on the gateway");
    expect(r.remedy).not.toMatch(/OpenAI/);
  });
});

describe("gateway rate limits", () => {
  it("maps a 429 to 'Gateway rate limit' with no auth-mode advice", () => {
    const r = standard(
      'API Error: 429 {"error":{"message":"Max parallel request limit reached","type":"None","code":"429"}}',
    );
    expect(r.title).toBe("Gateway rate limit");
    expect(r.retryable).toBe(true);
  });

  it("and a 503 from the gateway's rate-limit store", () => {
    const r = standard(
      "litellm.ServiceUnavailableError: 503 redis connection refused in parallel_request_limiter",
    );
    expect(r.title).toBe("Gateway rate limit");
    expect(standard("No deployments available for selected model").title).toBe(
      "Gateway rate limit",
    );
  });

  it("a GitLab 429 is GitLab's, not the gateway's", () => {
    const r = standard('GitLab API error 429: {"message":"Retry later"}');
    expect(r.title).toBe("GitLab rate limit");
  });
});

describe("private CA", () => {
  for (const message of [
    "Error: self signed certificate in certificate chain",
    "Error: self-signed certificate in certificate chain",
    "unable to get local issuer certificate",
    "FetchError: request failed, reason: UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "fatal: unable to access 'https://gitlab.example.test/platform/app.git/': SSL certificate problem: unable to get local issuer certificate",
    "server certificate verification failed. CAfile: none CRLfile: none",
    "x509: certificate signed by unknown authority",
  ]) {
    it(`"${message.slice(0, 50)}…" is 'Private CA not trusted', pointing at caBundle`, () => {
      const r = standard(message);
      expect(r.title).toBe("Private CA not trusted");
      expect(r.remedy).toContain("caBundle");
      expect(r.retryable).toBe(false);
    });
  }

  it("an image pull stopped by the registry's certificate gets the nodes' fix, not caBundle", () => {
    for (const message of [
      'Failed to pull image "registry.example.test/optio-agent:1": rpc error: code = Unknown desc = failed to pull and unpack image "registry.example.test/optio-agent:1": failed to resolve reference: failed to do request: Head "https://registry.example.test/v2/optio-agent/manifests/1": tls: failed to verify certificate: x509: certificate signed by unknown authority (ErrImagePull)',
      "Back-off pulling image: ImagePullBackOff — x509: certificate signed by unknown authority",
    ]) {
      const r = standard(message);
      expect(r.title).toBe("Registry CA not trusted by the nodes");
      expect(r.category).toBe("image");
      expect(r.remedy).toContain("registries.yaml");
      expect(r.remedy).toContain("/etc/containerd/certs.d/<registry>/ca.crt");
      // The chart's caBundle is named only to say it doesn't help here.
      expect(r.remedy).toContain("caBundle doesn't reach the nodes");
    }
  });

  it("leaves upstream's other earlier rules their TLS messages", () => {
    expect(
      standard(
        "Timed out waiting for pod to be Running after 300s: x509: certificate signed by unknown authority",
      ).title,
    ).toBe("Pod startup timed out");
  });
});

describe("GitLab token", () => {
  it("maps Optio's GitLab 401 and 403 to 'GitLab token refused' with the order of tokens", () => {
    for (const message of [
      'GitLab API error 401: {"message":"401 Unauthorized"}',
      'GitLab API error 403: {"message":"403 Forbidden"}',
    ]) {
      const r = standard(message);
      expect(r.title).toBe("GitLab token refused");
      expect(r.remedy).toContain("Settings → My tokens");
      expect(r.remedy).toContain("GITLAB_TOKEN");
    }
  });

  it("and git's and glab's own words", () => {
    for (const message of [
      "remote: HTTP Basic: Access denied. The provided password or token is incorrect",
      "fatal: Authentication failed for 'https://gitlab.example.test/platform/app.git/'",
      "error: The requested URL returned error: 403",
      "glab: 401 Unauthorized (HTTP 401)",
      "remote: You are not allowed to push code to this project.",
    ]) {
      expect(standard(message).title, message).toBe("GitLab token refused");
    }
  });

  it("names the scope when the message does", () => {
    const team = standard("The Platform team's GitLab token was rejected: 401");
    expect(team.remedy).toContain("Teams → Platform → Tokens");
    const org = standard("The organization's GitLab token expired on 2026-10-01");
    expect(org.remedy).toContain("Deployment secrets");
  });

  it("a missing GitLab token", () => {
    const r = standard(
      "No GitLab token available. Add a GITLAB_TOKEN secret or set the GITLAB_TOKEN environment variable.",
    );
    expect(r.title).toBe("GitLab token missing");
  });
});

describe("nothing in a GitLab-only deployment reaches upstream's sign-in or auth-mode advice", () => {
  it("OpenCode's gateway token (OPENAI_API_KEY) is the gateway's, not OpenAI's", () => {
    const r = standard("Error: OPENAI_API_KEY is invalid");
    expect(r.title).toBe("Gateway sign-in failed");
    expect(r.remedy).not.toMatch(/OpenAI API key/);
  });

  it("a message upstream would call a rate limit gets advice that holds here", () => {
    // A bare 429 inside a number: upstream's pattern matches it; the gateway's doesn't.
    const r = standard("Agent exited after 14290ms");
    expect(r.title).toBe("Rate limit");
    expect(r.retryable).toBe(true);
    expect(standard("github api error 403: API rate limit exceeded for user").title).toBe(
      "Rate limit",
    );
  });

  it("leaves image pulls and other earlier upstream rules to upstream", () => {
    expect(
      standard("ErrImagePull: toomanyrequests: You have reached your pull rate limit").title,
    ).toBe("Container image not found");
    expect(standard("OOMKilled: rate limit while writing").title).toBe("Out of memory");
    expect(standard("Timed out waiting for pod to be Running after 300s (429)").title).toBe(
      "Pod startup timed out",
    );
  });

  it("sweeps upstream's own sample messages", () => {
    for (const message of [
      "OAuth token has expired",
      "authentication_failed",
      "401 authentication error",
      "Claude OAuth token is expired (detected by pre-flight validation)",
      "ANTHROPIC_API_KEY not set",
      "429 Too Many Requests",
      "rate limit exceeded",
      "rate_limit_error",
      "overloaded_error",
      "API Error: 529 overloaded",
    ]) {
      standard(message);
    }
  });
});

describe("model access", () => {
  it("does nothing by default: upstream's Keychain advice and auth-mode advice stay", () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "");
    expect(classifySiteError("Budget has been exceeded!")).toBeNull();
    expect(classifyError("OAuth token has expired").remedy).toContain("Keychain");
    expect(classifyError("429 Too Many Requests").remedy).toContain("switch to API key auth");
  });

  it("leaves what it doesn't know to upstream with gateway-only access", () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    expect(classifySiteError("Error: ImagePullBackOff")).toBeNull();
    expect(classifyError("Error: ImagePullBackOff").title).toBe("Container image not found");
  });

  it("reads the features the web layout injected, in a browser", () => {
    vi.stubEnv("OPTIO_MODEL_ACCESS", "gateway");
    const g = globalThis as unknown as { window?: unknown };
    const had = "window" in g;
    const before = g.window;
    g.window = { __OPTIO_CONFIG: { features: { modelAccess: "any" } } };
    try {
      expect(classifySiteError("Budget has been exceeded!")).toBeNull();
      g.window = { __OPTIO_CONFIG: { features: { modelAccess: "gateway" } } };
      expect(classifySiteError("Budget has been exceeded!")?.title).toBe("Gateway budget used up");
    } finally {
      if (had) g.window = before;
      else delete g.window;
    }
  });
});
