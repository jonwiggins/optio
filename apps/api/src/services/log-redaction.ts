/**
 * Secrets masked in run output before it is stored in `task_logs` and sent
 * in a live frame (run-log-service.ts is the one writer, and every live
 * frame carries the stored row).
 *
 * Two layers:
 *
 * - The run's own secrets (on with `OPTIO_LOG_REDACT_SECRETS=true`): the
 *   exact values Optio put in the run's environment — the secrets it
 *   resolved for the run, its pod secrets and connection env, its git
 *   token, its model sign-in — each replaced by `[redacted:NAME]`. Only
 *   values of 8 or more characters count, and only values Optio itself
 *   handed the agent as credentials, so the mask can't hit ordinary output:
 *   a string that equals one of them is that credential.
 * - Well-known token shapes (off unless `OPTIO_LOG_REDACT_PATTERNS=true`):
 *   GitHub and GitLab tokens, AWS access key ids, JWTs, private key blocks,
 *   `Bearer` credentials, wherever they came from. A pattern can match text
 *   that only looks like a token, which is why it is opt-in.
 *
 * Any API instance may write a run's lines (the one that started it, or one
 * that attached after a restart), so the run's values are kept twice: in
 * this process, and sealed in Redis (AES-GCM under the deployment's
 * encryption key, bound to the run id) for the instance that attaches
 * later. The Redis copy expires after {@link RUN_SECRETS_TTL_SECS}.
 */
import { decrypt, encrypt, isOptioConfigSecret, type EncryptedBlob } from "./secret-service.js";
import { getRedisClient } from "./event-bus.js";
import { logger } from "../logger.js";

/** Shorter values are not masked: they would hit ordinary text. */
export const MIN_SECRET_LENGTH = 8;

/** How long the sealed copy of a run's values lives in Redis (refreshed on each read). */
export const RUN_SECRETS_TTL_SECS = 7 * 24 * 60 * 60;

/** How long "this run has no values" is believed before Redis is asked again. */
const NEGATIVE_CACHE_MS = 10_000;

/** Runs whose values this process keeps (oldest dropped first; Redis has the rest). */
const MAX_CACHED_RUNS = 2_000;

export function redactRunSecretsEnabled(): boolean {
  return process.env.OPTIO_LOG_REDACT_SECRETS === "true";
}

export function redactTokenPatternsEnabled(): boolean {
  return process.env.OPTIO_LOG_REDACT_PATTERNS === "true";
}

// ── Which env values are secrets ────────────────────────────────────────────

/** Name parts that make an env value a credential (`GITLAB_TOKEN`, `DB_PASSWORD`, …). */
const SECRET_NAME_PARTS = new Set([
  "TOKEN",
  "SECRET",
  "PASSWORD",
  "PASSWD",
  "CREDENTIAL",
  "CREDENTIALS",
  "APIKEY",
]);
/** `KEY` counts after one of these (`API_KEY`, `ACCESS_KEY`), not alone (`OPTIO_JIRA_KEY`). */
const KEY_QUALIFIERS = new Set(["API", "ACCESS", "PRIVATE", "AUTH", "SIGNING", "ACCOUNT"]);

/** Settings kept in the secret store that are not credentials (a region, a host, a mode). */
const NOT_CREDENTIALS = new Set([
  "GITLAB_HOST",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_CLOUD_LOCATION",
  "AWS_REGION",
]);

/** Whether an env variable's name says its value is a credential. */
export function isCredentialName(name: string): boolean {
  const parts = name.toUpperCase().split(/[^A-Z0-9]+/);
  return parts.some(
    (part, i) =>
      SECRET_NAME_PARTS.has(part) || (part === "KEY" && KEY_QUALIFIERS.has(parts[i - 1])),
  );
}

/**
 * The values to mask in a run's output, by name: every value from the
 * secret stores the run resolved (`fromSecrets`: its secrets, pod secrets,
 * connection env), and every value of `env` whose name says it is a
 * credential (git tokens, model keys, OAuth tokens, minted tokens). Optio's
 * own settings kept as secrets (auth modes, hosts, regions) are left out,
 * and so is anything shorter than {@link MIN_SECRET_LENGTH}.
 */
export function runSecretValues(
  env: Record<string, string>,
  fromSecrets: Array<Record<string, string> | null | undefined> = [],
): Map<string, string> {
  const out = new Map<string, string>();
  const add = (name: string, value: unknown) => {
    if (typeof value !== "string" || value.length < MIN_SECRET_LENGTH) return;
    if (!isCredentialName(name) && (isOptioConfigSecret(name) || NOT_CREDENTIALS.has(name))) return;
    if (!out.has(value)) out.set(value, name);
  };
  for (const source of fromSecrets) {
    for (const [name, value] of Object.entries(source ?? {})) add(name, value);
  }
  for (const [name, value] of Object.entries(env)) {
    if (isCredentialName(name)) add(name, value);
  }
  return out;
}

// ── The redactor ────────────────────────────────────────────────────────────

/** Token shapes masked with `OPTIO_LOG_REDACT_PATTERNS=true`. Each is linear on long input. */
export const TOKEN_PATTERNS: ReadonlyArray<{ name: string; re: RegExp; keep?: string }> = [
  {
    name: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  {
    name: "gitlab-token",
    re: /\b(?:glpat|gloas|gldt|glrtr?|glcbt|glptt|glft|glimt|glagent|glsoat|glffct|glwt)-[A-Za-z0-9_-]{20,}/g,
  },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // The scheme stays, so the line still says what kind of credential went where.
  { name: "bearer", re: /\b(Bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi, keep: "$1" },
];

/**
 * Masks one run's secrets in text. Exact values go first, longest first (a
 * value inside another is masked as part of the longer one), each found
 * with `includes` — a plain substring search, linear in the text — and the
 * patterns, when on, after.
 */
export class Redactor {
  /** [needle, label], longest needle first. */
  private readonly needles: Array<[string, string]>;

  constructor(
    values: Map<string, string>,
    private readonly patterns: boolean,
  ) {
    const needles = new Map<string, string>();
    for (const [value, name] of values) {
      const label = `[redacted:${name}]`;
      // The value as it appears in a URL and inside a JSON string, too.
      for (const form of [value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]) {
        if (form.length >= MIN_SECRET_LENGTH && !needles.has(form)) needles.set(form, label);
      }
    }
    this.needles = [...needles].sort((a, b) => b[0].length - a[0].length);
  }

  get empty(): boolean {
    return this.needles.length === 0 && !this.patterns;
  }

  redact(text: string): string {
    let out = text;
    for (const [needle, label] of this.needles) {
      if (out.includes(needle)) out = out.split(needle).join(label);
    }
    if (this.patterns) {
      for (const { name, re, keep } of TOKEN_PATTERNS) {
        out = out.replace(re, `${keep ?? ""}[redacted:${name}]`);
      }
    }
    return out;
  }

  /** Every string inside a JSON value (a log line's metadata: tool input, tool output). */
  redactJson<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactJson(v)) as T;
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = this.redactJson(v);
      return out as T;
    }
    return value;
  }
}

// ── A run's values, across instances ────────────────────────────────────────

type Cached = { values: Map<string, string> } | { none: true; at: number };
const cache = new Map<string, Cached>();

function remember(runId: string, entry: Cached): void {
  cache.delete(runId);
  cache.set(runId, entry);
  if (cache.size > MAX_CACHED_RUNS) cache.delete(cache.keys().next().value!);
}

const redisKey = (runId: string) => `optio:run-log-redaction:${runId}`;
const aadOf = (runId: string) => Buffer.from(`run-log-redaction|${runId}`);

/**
 * Keeps a run's values for its output (call before the agent starts). The
 * sealed Redis copy is what another instance reads when it attaches to the
 * run; failing to write it is logged, not thrown — this instance still
 * masks what it writes.
 */
export async function registerRunSecrets(
  runId: string,
  values: Map<string, string>,
): Promise<void> {
  if (!redactRunSecretsEnabled() || values.size === 0) return;
  remember(runId, { values });
  try {
    const blob = encrypt(JSON.stringify([...values]), aadOf(runId));
    const sealed = JSON.stringify({
      alg: blob.alg,
      iv: blob.iv.toString("base64"),
      ct: blob.ciphertext.toString("base64"),
      tag: blob.authTag.toString("base64"),
    });
    await getRedisClient().set(redisKey(runId), sealed, "EX", RUN_SECRETS_TTL_SECS);
  } catch (err) {
    logger.warn(
      { err, runId },
      "Could not share the run's log redaction values with other instances",
    );
  }
}

async function loadRunSecrets(runId: string): Promise<Map<string, string> | null> {
  const hit = cache.get(runId);
  if (hit && "values" in hit) return hit.values;
  if (hit && Date.now() - hit.at < NEGATIVE_CACHE_MS) return null;
  try {
    const redis = getRedisClient();
    const sealed = await redis.get(redisKey(runId));
    if (!sealed) {
      remember(runId, { none: true, at: Date.now() });
      return null;
    }
    const s = JSON.parse(sealed) as { alg: number; iv: string; ct: string; tag: string };
    const blob: EncryptedBlob = {
      alg: s.alg,
      iv: Buffer.from(s.iv, "base64"),
      ciphertext: Buffer.from(s.ct, "base64"),
      authTag: Buffer.from(s.tag, "base64"),
    };
    const values = new Map(JSON.parse(decrypt(blob, aadOf(runId))) as Array<[string, string]>);
    await redis.expire(redisKey(runId), RUN_SECRETS_TTL_SECS).catch(() => {});
    remember(runId, { values });
    return values;
  } catch (err) {
    logger.warn({ err, runId }, "Could not read the run's log redaction values");
    return null;
  }
}

const NO_VALUES = new Map<string, string>();
/** One redactor per run's values and pattern setting (its needles are sorted once). */
const redactors = new WeakMap<Map<string, string>, Map<boolean, Redactor>>();

/** The redactor for a run's lines, or null when there is nothing to mask. */
export async function redactorForRun(runId: string): Promise<Redactor | null> {
  const values = (redactRunSecretsEnabled() ? await loadRunSecrets(runId) : null) ?? NO_VALUES;
  const patterns = redactTokenPatternsEnabled();
  let byPatterns = redactors.get(values);
  if (!byPatterns) redactors.set(values, (byPatterns = new Map()));
  let redactor = byPatterns.get(patterns);
  if (!redactor) byPatterns.set(patterns, (redactor = new Redactor(values, patterns)));
  return redactor.empty ? null : redactor;
}

/** Test hook: forget what this process cached. */
export function _resetRunSecretCache(): void {
  cache.clear();
}
