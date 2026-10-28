/**
 * The `bodyMatches` filter of a GitHub trigger: a comment fires it when its
 * body starts with the text (case-insensitive, leading whitespace ignored) —
 * `/optio retry` for a slash command — or, written `/pattern/flags`, when
 * the regex matches it anywhere.
 *
 * A regex here runs on the API server against every matching delivery, so
 * it has to be one that can't blow up: a repeated group that itself repeats
 * or alternates (`(a+)+`, `(a|aa)*`) and backreferences are refused, it only
 * sees the first thousand characters, and the flags are limited to `i`, `m`,
 * `s` and `u`. `/deploy/prod` isn't a regex (its "flags" aren't
 * flags) and is taken as the prefix it looks like.
 */

/** The longest `bodyMatches` a trigger stores. */
export const BODY_PATTERN_MAX = 200;

const REGEX_FORM = /^\/(.+)\/([imsu]*)$/s;

/**
 * Why a regex can't be used as a `bodyMatches` pattern, or null when it can:
 * no quantifier may apply to a group that itself contains a quantifier or
 * an alternation (`(a+)+`, `(a|aa)*` — the shapes catastrophic backtracking
 * takes), and no backreferences. Alternation and repetition on their own
 * are fine (`^\/optio (retry|rerun)`, `[a-z]+`).
 */
export function unsafeRegexReason(pattern: string): string | null {
  // Each open group: whether a quantifier or an alternation was seen inside it.
  const groups: { repeats: boolean; alternates: boolean }[] = [];
  let lastWasGroupClose = false;
  let closedGroupWasComplex = false;
  let sawQuantifier = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      if (/[1-9]/.test(pattern[i + 1] ?? "") || pattern.startsWith("k<", i + 1)) {
        return "backreferences aren't allowed";
      }
      i++;
      lastWasGroupClose = false;
      sawQuantifier = false;
      continue;
    }
    if (ch === "[") {
      // A character class: skip to its end (a `]` right after `[` or `[^` is literal).
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") {
        if (pattern[j] === "\\") j++;
        j++;
      }
      i = j;
      lastWasGroupClose = false;
      sawQuantifier = false;
      continue;
    }
    if (ch === "(") {
      groups.push({ repeats: false, alternates: false });
      lastWasGroupClose = false;
      sawQuantifier = false;
      continue;
    }
    if (ch === ")") {
      const closed = groups.pop();
      closedGroupWasComplex = !!closed && (closed.repeats || closed.alternates);
      // What's inside an inner group is inside the outer one too.
      if (closedGroupWasComplex && groups.length > 0) groups[groups.length - 1].alternates = true;
      lastWasGroupClose = true;
      sawQuantifier = false;
      continue;
    }
    if (ch === "|") {
      if (groups.length > 0) groups[groups.length - 1].alternates = true;
      lastWasGroupClose = false;
      sawQuantifier = false;
      continue;
    }
    const quantifier =
      ch === "*" ||
      ch === "+" ||
      ch === "?" ||
      (ch === "{" && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)));
    if (quantifier) {
      // `?` right after another quantifier only makes it lazy.
      if (ch === "?" && sawQuantifier) {
        sawQuantifier = false;
        continue;
      }
      if (ch === "{") i = pattern.indexOf("}", i);
      if (lastWasGroupClose && closedGroupWasComplex) {
        return "a repeated group can't itself contain repetition or alternation (nested quantifiers)";
      }
      for (const g of groups) g.repeats = true;
      sawQuantifier = true;
      lastWasGroupClose = false;
      continue;
    }
    sawQuantifier = false;
    lastWasGroupClose = false;
  }
  return null;
}

/**
 * Parse a `bodyMatches` value. A `/pattern/flags` form becomes a RegExp (or
 * an error when it doesn't compile or could backtrack catastrophically);
 * anything else is a prefix.
 */
export function parseBodyPattern(
  pattern: string,
): { prefix: string } | { regex: RegExp } | { error: string } {
  const p = pattern.trim();
  const m = REGEX_FORM.exec(p);
  if (!m) return { prefix: p };
  const unsafe = unsafeRegexReason(m[1]);
  if (unsafe) return { error: unsafe };
  try {
    return { regex: new RegExp(m[1], m[2]) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : "invalid regex" };
  }
}

/**
 * The most of a comment a regex is matched against: slash commands sit at
 * the top, and a short input bounds the polynomial backtracking the shape
 * check above can't rule out (`a*a*a*b`).
 */
const BODY_MATCH_MAX = 1_000;

/** Whether `body` satisfies `pattern`; no pattern = anything, no body = nothing. */
export function bodyMatches(pattern: string | undefined | null, body: string | null): boolean {
  const p = (pattern ?? "").trim();
  if (!p) return true;
  if (!body) return false;
  const parsed = parseBodyPattern(p);
  if ("error" in parsed) return false;
  if ("regex" in parsed) return parsed.regex.test(body.slice(0, BODY_MATCH_MAX));
  return body.trimStart().toLowerCase().startsWith(parsed.prefix.toLowerCase());
}
