/**
 * Failure messages for a deployment whose agents reach their models
 * through a model gateway only (`OPTIO_MODEL_ACCESS=gateway`,
 * docs/credential-health.md "Failure messages"): rules `classifyError` tries
 * before upstream's. Such a deployment signs in to the gateway (LiteLLM)
 * with per-person / per-team / organization tokens, often keeps its code on
 * its own GitLab, and runs services whose certificates come from a private
 * CA. Upstream's rules give advice that is wrong there: a 401 says to copy a
 * Claude token out of the macOS Keychain, a 429 to "switch to API key
 * auth", and there is no rule at all for a budget, a gateway key or a
 * certificate.
 *
 * With the default model access (`any`) nothing here applies: upstream's
 * classifier. The hook is one call at the top of `classifyError`
 * (error-classifier.ts). The setting is the server's env, or the layout's
 * `window.__OPTIO_CONFIG.features` in the browser (`currentFeatures`).
 *
 * Every remedy names the place this Optio fixes it: Settings → My tokens,
 * Teams → the team → Tokens, Settings → Model gateway, the chart's
 * `caBundle`. A message Optio wrote itself (the gateway pre-flight, a missing
 * token) says whose token it was, and the remedy follows it.
 */
import type { ClassifiedError } from "./error-classifier.js";
import { currentFeatures } from "./config/features.js";

interface SiteRule {
  pattern: RegExp;
  /** Must also be in the message for the rule to answer. */
  requires?: RegExp;
  /** Messages the rule leaves to the next one (upstream's, usually). */
  unless?: RegExp;
  classify: (match: RegExpMatchArray, message: string) => ClassifiedError;
}

/** Whose token a message says it was: Optio's own messages name it. */
type TokenScope = { kind: "person" } | { kind: "team"; team: string | null } | { kind: "org" };

function scopeOf(message: string, what: "gateway" | "GitLab"): TokenScope | null {
  const team =
    message.match(new RegExp(`the (.+?) team's ${what} token`, "i")) ??
    message.match(/Teams → (.+?) → Tokens/);
  if (team) return { kind: "team", team: team[1] };
  if (
    new RegExp(`your team's ${what} token|team's ${what} token|team has no ${what}`, "i").test(
      message,
    )
  )
    return { kind: "team", team: null };
  if (
    new RegExp(
      `organization(?:'s)? (?:has no )?${what} token|organization has no ${what}`,
      "i",
    ).test(message)
  )
    return { kind: "org" };
  if (
    new RegExp(`your ${what} token|your own ${what} token|add your ${what} token`, "i").test(
      message,
    )
  )
    return { kind: "person" };
  return null;
}

const GATEWAY_ORDER =
  "Whose token it was: a team's work uses the team's token (Teams → the team → Tokens), " +
  "your own work your token (Settings → My tokens), the organization's work the " +
  "organization's token (Settings → Model gateway).";

function gatewayFix(scope: TokenScope | null, action: string): string {
  if (!scope) return `${GATEWAY_ORDER} ${action}`;
  if (scope.kind === "team") {
    return `${action} A team admin does it under Teams → ${scope.team ?? "the team"} → Tokens.`;
  }
  if (scope.kind === "org") return `${action} An admin does it under Settings → Model gateway.`;
  return `${action} Yours is under Settings → My tokens.`;
}

const GITLAB_ORDER =
  "Optio uses, in this order: the team's token for a team's work (Teams → the team → " +
  "Tokens), else the work owner's own (Settings → My tokens), else the organization's " +
  "(GITLAB_TOKEN under Settings → Integrations → Deployment secrets).";

function gitlabFix(scope: TokenScope | null): string {
  const replace = "Replace it with a token that has the api scope, then retry.";
  if (!scope) return `${GITLAB_ORDER} ${replace}`;
  if (scope.kind === "team") {
    return `It was the team's token: a team admin replaces it under Teams → ${scope.team ?? "the team"} → Tokens. ${replace}`;
  }
  if (scope.kind === "org") {
    return `It was the organization's token: a deployment admin replaces GITLAB_TOKEN under Settings → Integrations → Deployment secrets. ${replace}`;
  }
  return `It was your own token: replace it under Settings → My tokens. ${replace}`;
}

const HEALTH = "Settings → System health shows which tokens are failing and why.";

/**
 * Messages upstream answers with a rule that comes before the one a broad
 * rule here stands in for (an image, a pod that didn't start, a missing or
 * undecryptable secret; before its rate-limit rule also memory, context,
 * quota, model and other agents' keys): the broad rules leave them to it, so
 * only the advice changes, never which rule answers. One exception: an image
 * pull that fails on the registry's certificate gets the nodes' fix (the
 * first rule below), since upstream's says to build the image locally.
 */
const BEFORE_SIGN_IN =
  /ErrImageNeverPull|InvalidImageName|ImagePullBackOff|ErrImagePull|failed to pull.*image|Timed out waiting for pod|Secret not found|failed to decrypt|unable to authenticate data/i;
const BEFORE_RATE_LIMIT = new RegExp(
  [
    BEFORE_SIGN_IN.source,
    "OPENCLAW_API_KEY|CURSOR_API_KEY|API[_ ]?KEY[_ ]?INVALID|API key not valid|GEMINI_API_KEY",
    "COPILOT_GITHUB_TOKEN|copilot.*auth|copilot.*unauthorized|subscription.*required",
    "insufficient_quota|billing.*hard.*limit|exceeded.*current.*quota",
    "model.*not.?found|model_not_found|does not exist.*model|invalid.*model",
    "context.?length.*exceeded|maximum.?context|too many tokens|token.?limit",
    "content.?filter|content.?policy|safety.?system|InvalidTransitionError|OOMKilled|out of memory",
  ].join("|"),
  "i",
);

/**
 * A certificate signed by a CA the client doesn't trust: Node
 * (UNABLE_TO_VERIFY_LEAF_SIGNATURE, SELF_SIGNED_CERT_IN_CHAIN, …), OpenSSL /
 * curl / git ("SSL certificate problem", "server certificate verification
 * failed"), Python ("certificate verify failed"), Go (containerd, glab:
 * "x509: certificate signed by unknown authority").
 */
const UNTRUSTED_CA =
  /self[- ]signed certificate in certificate chain|unable to get local issuer certificate|UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|DEPTH_ZERO_SELF_SIGNED_CERT|UNABLE_TO_GET_ISSUER_CERT(?:_LOCALLY)?|unable to verify the first certificate|SSL certificate problem|server certificate verification failed|certificate verify failed|x509: certificate signed by unknown authority/i;

/** An image the node couldn't pull (upstream's image rules). */
const IMAGE_PULL = /ErrImagePull|ImagePullBackOff|failed to pull.*image/i;

const SITE_RULES: SiteRule[] = [
  // ── The agent policy's file, in an image too old for it ─────────────────
  // Optio writes the deny rules into /etc/claude-code (agent-policy.ts); an
  // agent image built before agent policy has no such directory the agent
  // user may write, and the run stops rather than start without its rules.
  {
    pattern: /Permission denied: '\/etc\/claude-code/,
    classify: () => ({
      category: "image",
      title: "Agent image too old for the agent policy",
      description:
        "Optio couldn't write the agent policy's deny rules into the pod " +
        "(/etc/claude-code/managed-settings.json): the agent image was built before agent " +
        "policy, so the run stopped instead of starting without them.",
      remedy:
        "Build the agent images from this Optio release (they make /etc/claude-code the " +
        "agent user's) and point the chart at them. Until then, only work whose agent policy " +
        "has no rules starts (Workspace settings → Agent policy, docs/agent-policy.md).",
      retryable: false,
    }),
  },

  // ── An image pull the registry's certificate stopped ───────────────────
  // The kubelet's container runtime (containerd) pulls the agent image, not
  // Optio or the pod: the chart's caBundle never reaches it, so the fix is
  // the nodes'. Upstream's image rule would say to build the image locally.
  {
    pattern: IMAGE_PULL,
    requires: UNTRUSTED_CA,
    classify: () => ({
      category: "image",
      title: "Registry CA not trusted by the nodes",
      description:
        "The cluster's nodes couldn't pull the agent image: the registry's certificate is " +
        "signed by a CA their container runtime doesn't trust.",
      remedy:
        "The cluster admin makes each node trust the deployment's root CA for the registry: on " +
        "RKE2 / K3s, the registry's tls ca_file in registries.yaml; on plain containerd, " +
        "/etc/containerd/certs.d/<registry>/ca.crt (or the node's system trust store), then " +
        "restart the runtime. The chart's caBundle doesn't reach the nodes. Then retry.",
      retryable: false,
    }),
  },

  // ── A private CA nobody told the client about ──────────────────────────
  // Optio or the agent's pod met it (GitLab, the gateway, Jira, a remote-workspace provider, the
  // directory). Upstream's earlier rules (an image, a pod that didn't start,
  // a secret) keep their messages, as everywhere here.
  {
    pattern: UNTRUSTED_CA,
    unless: BEFORE_SIGN_IN,
    classify: () => ({
      category: "network",
      title: "Private CA not trusted",
      description:
        "A connection to one of this deployment's services (GitLab, the model gateway, Jira, a remote-workspace provider, " +
        "the directory) failed: its certificate is signed by a CA that Optio or the agent's pod " +
        "doesn't trust.",
      remedy:
        "Put the deployment's root CA (PEM) in the chart's caBundle value (caBundle.pem, or " +
        "caBundle.configMap for a ConfigMap you keep) and upgrade the release: the API trusts it, " +
        "and every agent pod gets it through SSL_CERT_FILE, GIT_SSL_CAINFO and " +
        "NODE_EXTRA_CA_CERTS. One service can also take its own CA: the CA field of a Jira or " +
        "remote-workspace connection, or OPTIO_GATEWAY_CA_PEM for the model gateway. Then retry.",
      retryable: false,
    }),
  },

  // ── The gateway's budget ────────────────────────────────────────────────
  // LiteLLM: `budget_exceeded`, "Budget has been exceeded! Current cost: …,
  // Max budget: …", ExceededTokenBudget / ExceededBudget; Optio's own
  // pre-flight: "… gateway token is over budget until <reset> …".
  {
    pattern:
      /budget_exceeded|Exceeded(?:Token)?Budget|Budget has been exceeded|gateway token is over budget/i,
    classify: (_match, message) => {
      const reset = message.match(/until (\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC)/)?.[1] ?? null;
      const spent = message.match(/Current cost: ?([\d.]+),? ?Max budget: ?([\d.]+)/i);
      return {
        category: "auth",
        title: "Gateway budget used up",
        description:
          "The model gateway turned the token away: its budget is spent" +
          (spent ? ` (${spent[1]} of ${spent[2]} USD)` : "") +
          (reset ? `. It resets ${reset}.` : "."),
        remedy: gatewayFix(
          scopeOf(message, "gateway"),
          reset
            ? `Wait for the reset, or raise the token's budget on the gateway (ask its admin) or put in another token.`
            : `Ask the gateway's admin to raise the token's budget, or put in another token.`,
        ),
        retryable: false,
      };
    },
  },

  // ── No token for the work's owner (model-gateway-service.ts) ───────────
  {
    pattern:
      /Add your gateway token under|has no gateway token|no gateway token yet|has no shared token stored/i,
    classify: (_match, message) => ({
      category: "auth",
      title: "Gateway token missing",
      description: message,
      remedy: gatewayFix(scopeOf(message, "gateway"), "Add the token, then retry."),
      retryable: false,
    }),
  },

  // ── A model the token may not use, or the gateway doesn't serve ────────
  {
    pattern:
      /Invalid model name passed in model|not allowed to access model|doesn't serve the model|has no models for/i,
    classify: () => ({
      category: "agent",
      title: "Model not on the gateway",
      description:
        "The gateway doesn't serve the model this work asked for, or the token may not use it.",
      remedy:
        "Pick a model the gateway serves (the work form lists the catalog; an admin syncs it " +
        "under Settings → Model gateway), or ask the gateway's admin to give the token access to " +
        "this model. Then retry.",
      retryable: false,
    }),
  },

  // ── GitLab ──────────────────────────────────────────────────────────────
  {
    pattern: /No GitLab token available/i,
    classify: () => ({
      category: "auth",
      title: "GitLab token missing",
      description: "Optio found no GitLab token for this work.",
      remedy: `${GITLAB_ORDER} Add one with the api scope, then retry.`,
      retryable: false,
    }),
  },
  {
    pattern: /GitLab API error 429|gitlab[^\n]{0,120}\b429\b|\b429\b[^\n]{0,120}gitlab/i,
    classify: () => ({
      category: "auth",
      title: "GitLab rate limit",
      description: "GitLab is limiting requests from this token's user.",
      remedy:
        "Wait a few minutes and retry. If it keeps happening, ask the GitLab admin to raise " +
        "the rate limits for the token's user, or give the work its own token.",
      retryable: true,
    }),
  },
  {
    pattern:
      /GitLab API error 40[13]|HTTP Basic: Access denied|remote: You are not allowed to (?:push|download) code|fatal: Authentication failed for '[^']*'|The requested URL returned error: 40[13]|insufficient_scope|glab[^\n]{0,200}\b40[13]\b|\b40[13]\b[^\n]{0,60}(?:Unauthorized|Forbidden)[^\n]{0,200}gitlab|(?:your|team's|organization's) GitLab token (?:was )?(?:refused|rejected|expired)/i,
    classify: (_match, message) => {
      const scope = scopeOf(message, "GitLab");
      return {
        category: "auth",
        title: "GitLab token refused",
        description:
          "GitLab refused the token this work used (401 / 403): it expired or was revoked, " +
          "lacks the api scope, or its user isn't a Developer on the project (a Maintainer, " +
          "for Optio's webhooks).",
        remedy: `${gitlabFix(scope)} ${HEALTH}`,
        retryable: false,
      };
    },
  },

  // ── The gateway refused the token ──────────────────────────────────────
  // LiteLLM: "Authentication Error, Invalid proxy server token passed",
  // "Authentication Error - Expired Key", `expired_key`; Claude Code: "Invalid
  // API key · Please run /login"; Optio's pre-flight: "rejected by the gateway".
  {
    pattern:
      /Invalid proxy server token|Authentication Error[^\n]{0,20}(?:Expired Key|Invalid|Malformed)|expired_key|Expired Key|rejected by the gateway|gateway (?:refused|rejected) the token|Invalid API key[^\n]{0,20}Please run \/login|blocked on the gateway/i,
    classify: (_match, message) => ({
      category: "auth",
      title: "Gateway token rejected",
      description:
        "The model gateway refused the token: it is wrong, expired, blocked or no longer exists " +
        "on the gateway.",
      remedy: `${gatewayFix(scopeOf(message, "gateway"), "Put in a token the gateway accepts, then retry.")} ${HEALTH}`,
      retryable: false,
    }),
  },

  // ── The gateway's rate limits ──────────────────────────────────────────
  // A 429 (the token's rpm / tpm, LiteLLM's "No deployments available"), or
  // a 503 when the gateway's rate-limit store (Redis) is down.
  {
    pattern:
      /\b429\b|rate.?limit|too many requests|RateLimitError|No deployments available|(?:litellm|gateway|proxy|redis)[^\n]{0,200}\b503\b|\b503\b[^\n]{0,200}(?:litellm|gateway|proxy|redis)|overloaded_error/i,
    unless: new RegExp(
      `github api error|GitLab API error|OOMKilled|out of memory|InvalidTransitionError|${BEFORE_SIGN_IN.source}`,
      "i",
    ),
    classify: () => ({
      category: "auth",
      title: "Gateway rate limit",
      description:
        "The model gateway is limiting this token's requests (its requests- or tokens-per-minute " +
        "limit), or its rate-limit store is down (a 503).",
      remedy:
        "Wait a few minutes and retry. If it keeps happening, run fewer agents at once, or ask " +
        "the gateway's admin to raise the token's limits (or to check its Redis on a 503).",
      retryable: true,
    }),
  },

  // ── Anything else that reads as a failed sign-in ───────────────────────
  // Upstream sends these to the Claude OAuth / Keychain remedy; here the
  // agent signs in to the gateway only.
  // (OPENAI_API_KEY: the name OpenCode's gateway token travels under.)
  {
    pattern:
      /OAuth token has expired|authentication_failed|token.*expired|401.*authentication|pre-flight validation|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY/i,
    unless: BEFORE_SIGN_IN,
    classify: (_match, message) => ({
      category: "auth",
      title: "Gateway sign-in failed",
      description: "The agent couldn't sign in to the model gateway with the work's token.",
      remedy: `${gatewayFix(scopeOf(message, "gateway"), "Check the token, or put in a new one, then retry.")} ${HEALTH}`,
      retryable: false,
    }),
  },

  // ── What upstream calls a rate limit, anything else ────────────────────
  // Upstream's own pattern, so the same messages land here as there (a
  // GitHub write limit keeps its own rule), with advice that holds here:
  // there is no "API key auth" to switch to.
  {
    pattern: /rate.?limit|429|too many requests/i,
    unless: new RegExp(
      `github api error \\d+:.*(?:secondary rate limit|abuse detection)|${BEFORE_RATE_LIMIT.source}`,
      "is",
    ),
    classify: () => ({
      category: "auth",
      title: "Rate limit",
      description: "A service this work called is limiting its requests.",
      remedy:
        "Wait a few minutes and retry. The log says which service it was: the model gateway's " +
        "admin raises a token's limits, GitLab's admin a user's.",
      retryable: true,
    }),
  },
];

/**
 * The gateway deployment's classification of `message`, or null to let
 * upstream's rules decide (always null with the default model access).
 */
export function classifySiteError(message: string): ClassifiedError | null {
  if (currentFeatures().modelAccess !== "gateway") return null;
  for (const rule of SITE_RULES) {
    if (rule.unless?.test(message)) continue;
    if (rule.requires && !rule.requires.test(message)) continue;
    const match = message.match(rule.pattern);
    if (match) return rule.classify(match, message);
  }
  return null;
}
