/**
 * Secret-looking text masked before the bot quotes it in a thread
 * (replies.ts): a run's failure reason or summary can carry a token, and a
 * thread is for everyone on the project.
 */

const MASK = "[MASKED]";

/** Shapes of secrets a message may carry, masked wherever they appear. */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
    "[MASKED PRIVATE KEY]",
  ],
  // GitLab tokens (personal, deploy, runner, trigger, CI job, OAuth, …).
  [
    /\b(?:glpat|gloas|gldt|glrtr?|glcbt|glptt|glft|glimt|glagent|glsoat|glffct|glwt)-[A-Za-z0-9_-]{16,}/g,
    MASK,
  ],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, MASK],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
  // user:password@ in a URL.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
  [/(\bauthorization\s*[:=]\s*(?:bearer|basic|token)?\s*)[^\s"']+/gi, `$1${MASK}`],
  [/((?:private-token|x-api-key|api-key)\s*[:=]\s*)[^\s"']+/gi, `$1${MASK}`],
  // NAME=value / name: value where the name says it's a secret.
  [
    /(\b[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[A-Za-z0-9_.-]*["']?\s*[=:]\s*)("[^"\n]+"|'[^'\n]+'|[^\s,;"']{4,})/gi,
    `$1${MASK}`,
  ],
];

/** `text` with every secret shape and every known value (8+ characters) masked. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [re, by] of SECRET_SHAPES) out = out.replace(re, by);
  return out;
}
