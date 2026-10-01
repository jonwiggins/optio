/**
 * Which pull requests did an agent actually open?
 *
 * A PR URL in an agent's output is not evidence of anything: agents print
 * PRs they looked at (`gh pr view 812`), PRs they were told about, and
 * example URLs from their prompt. The evidence is a tool call that creates a
 * PR — `gh pr create`, `glab mr create`, a GitHub / GitLab MCP
 * `create_pull_request` — and the URL in *that call's own result*.
 *
 * This module is pure: it recognizes PR-creating calls (shell commands,
 * anywhere in a compound command, and MCP tools) and pulls the PR out of the
 * call's result. Callers pair calls with results (by tool_use id / call id)
 * and confirm what comes out against the git platform before adopting it.
 */

import { TASK_BRANCH_PREFIX } from "../constants.js";

/** A PR an agent's tool call created (or `gh pr create` reported as already existing). */
export interface PrToolCallMatch {
  /** The PR / MR web URL from the call's result (GitHub, GitLab, CodeCommit console). */
  url: string | null;
  /** `aws codecommit create-pull-request` prints JSON with an id instead of a URL. */
  codecommit: { pullRequestId: number; repositoryName: string } | null;
  /** The tool that created it (`Bash`, `mcp__github__create_pull_request`, …). */
  toolName: string;
  /** The create call reported the PR already existed (still this work's PR). */
  alreadyExisted: boolean;
}

/** One tool call and its result, as a transcript or an event stream pairs them. */
export interface ToolCallRecord {
  toolName: string;
  /** The tool's input: an object (`{ command }` for a shell tool), a JSON string, or a command string. */
  input: unknown;
  /** The result text; null while the call has no result. */
  result: string | null;
  isError: boolean;
}

// ── Branch ownership ────────────────────────────────────────────────────────

/**
 * True when `branch` belongs to the task: its own branch `optio/task-<id>`,
 * or an extra one under it — `optio/task-<id>-<slug>` (what the prompt asks
 * for; git can't hold both `optio/task-<id>` and `optio/task-<id>/x`) or
 * `optio/task-<id>/<slug>`.
 */
export function branchBelongsToTask(
  taskId: string,
  branch: string | null | undefined,
  prefix: string = TASK_BRANCH_PREFIX,
): boolean {
  if (!branch) return false;
  const own = `${prefix}${taskId}`;
  const b = branch.replace(/^refs\/heads\//, "");
  return b === own || b.startsWith(`${own}-`) || b.startsWith(`${own}/`);
}

// ── Shell scanning ──────────────────────────────────────────────────────────

/** Index of the `)` closing a `$(` whose content starts at `start`, or -1. */
function matchingParen(s: string, start: number): number {
  let depth = 1;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      i++;
    } else if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return -1;
      i = end;
    } else if (c === '"') {
      // Skip a double-quoted string (nested `$(` inside it is balanced by the recursion).
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\") i++;
        else if (s[i] === "$" && s[i + 1] === "(") {
          const end = matchingParen(s, i + 2);
          if (end < 0) return -1;
          i = end;
        }
        i++;
      }
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Split a shell script into simple commands, each a list of words with
 * quotes removed. Separators (`;` `&&` `||` `|` `&` newlines, subshell
 * parens), command substitutions (`$(…)`, backticks — also inside double
 * quotes), heredoc bodies (skipped), and comments are understood; anything
 * fancier only has to be good enough to find the command name and its
 * leading arguments.
 */
export function splitShellCommands(script: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const heredocs: { delim: string; strip: boolean }[] = [];

  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) out.push(words);
    words = [];
  };
  const substitute = (inner: string) => {
    out.push(...splitShellCommands(inner));
  };

  const s = script;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      if (s[i + 1] === "\n") {
        i += 2; // line continuation
        continue;
      }
      word += s[i + 1] ?? "";
      inWord = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      word += end < 0 ? s.slice(i + 1) : s.slice(i + 1, end);
      inWord = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      inWord = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) {
          word += s[i + 1];
          i += 2;
        } else if (s[i] === "$" && s[i + 1] === "(") {
          const end = matchingParen(s, i + 2);
          const inner = end < 0 ? s.slice(i + 2) : s.slice(i + 2, end);
          substitute(inner);
          word += "$()";
          i = end < 0 ? s.length : end + 1;
        } else if (s[i] === "`") {
          const end = s.indexOf("`", i + 1);
          substitute(end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
          word += "``";
          i = end < 0 ? s.length : end + 1;
        } else {
          word += s[i];
          i++;
        }
      }
      i++; // closing quote
      continue;
    }
    if (c === "$" && s[i + 1] === "(") {
      const end = matchingParen(s, i + 2);
      substitute(end < 0 ? s.slice(i + 2) : s.slice(i + 2, end));
      word += "$()";
      inWord = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", i + 1);
      substitute(end < 0 ? s.slice(i + 1) : s.slice(i + 1, end));
      word += "``";
      inWord = true;
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === "#" && !inWord) {
      while (i < s.length && s[i] !== "\n") i++;
      continue;
    }
    if (c === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
      // Heredoc: note the delimiter; its body is skipped at the next newline.
      endWord();
      i += 2;
      let strip = false;
      if (s[i] === "-") {
        strip = true;
        i++;
      }
      while (s[i] === " " || s[i] === "\t") i++;
      let delim = "";
      while (i < s.length && !/[\s;&|<>()]/.test(s[i])) {
        if (s[i] !== "'" && s[i] !== '"' && s[i] !== "\\") delim += s[i];
        i++;
      }
      if (delim) heredocs.push({ delim, strip });
      continue;
    }
    if (c === ">" || c === "<") {
      endWord();
      i++;
      while (s[i] === ">" || s[i] === "<") i++;
      if (s[i] === "&") {
        i++;
        while (i < s.length && /[0-9-]/.test(s[i])) i++;
      }
      continue;
    }
    if (c === "\n") {
      endCommand();
      i++;
      // Skip any heredoc bodies that start on this line.
      while (heredocs.length) {
        const { delim, strip } = heredocs.shift()!;
        while (i < s.length) {
          const nl = s.indexOf("\n", i);
          const line = nl < 0 ? s.slice(i) : s.slice(i, nl);
          i = nl < 0 ? s.length : nl + 1;
          if ((strip ? line.replace(/^\t+/, "") : line) === delim) break;
        }
      }
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endWord();
      i++;
      continue;
    }
    word += c;
    inWord = true;
    i++;
  }
  endCommand();
  return out;
}

const WRAPPERS = new Set(["sudo", "command", "time", "nohup", "exec", "builtin", "noglob"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);

function basename(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash >= 0 ? word.slice(slash + 1) : word;
}

/** Strip env assignments and wrappers (`sudo`, `env X=1`, …) off a command's words. */
function commandWords(words: string[]): string[] {
  let w = words;
  for (;;) {
    if (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w = w.slice(1);
    } else if (w.length && WRAPPERS.has(basename(w[0]))) {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = w.slice(1);
    } else if (w.length && basename(w[0]) === "env") {
      w = w.slice(1);
      while (w.length && (w[0].startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]))) {
        w = w.slice(1);
      }
    } else {
      return w;
    }
  }
}

/** Positional words after the command name, skipping flags (and the values of `valued` flags). */
function positionals(args: string[], valued: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (valued.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

const GH_VALUED = new Set(["-R", "--repo", "--hostname"]);
const AWS_VALUED = new Set([
  "--region",
  "--profile",
  "--output",
  "--endpoint-url",
  "--query",
  "--cli-read-timeout",
  "--cli-connect-timeout",
  "--color",
  "--ca-bundle",
]);

/** `gh api <endpoint> …` that creates a PR: POST to `repos/o/r/pulls`, or the GraphQL `createPullRequest` mutation. */
function isGhApiPrCreate(args: string[]): boolean {
  // args: everything after `api`
  let method: string | null = null;
  let hasFields = false;
  let endpoint: string | null = null;
  let graphqlCreate = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-X" || a === "--method") {
      method = (args[++i] ?? "").toUpperCase();
    } else if (a.startsWith("-X") && a.length > 2) {
      method = a.slice(2).toUpperCase();
    } else if (a.startsWith("--method=")) {
      method = a.slice("--method=".length).toUpperCase();
    } else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(a)) {
      hasFields = true;
      const value = args[++i] ?? "";
      if (/createPullRequest/.test(value)) graphqlCreate = true;
    } else if (/^(-f|-F|--field=|--raw-field=|--input=)/.test(a)) {
      hasFields = true;
      if (/createPullRequest/.test(a)) graphqlCreate = true;
    } else if (
      ["-H", "--header", "-q", "--jq", "-t", "--template", "--hostname", "--cache"].includes(a)
    ) {
      i++;
    } else if (!a.startsWith("-") && endpoint === null) {
      endpoint = a;
    }
  }
  if (!endpoint) return false;
  if (endpoint === "graphql") return graphqlCreate;
  const path = endpoint
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\/+/, "")
    .replace(/\?.*$/, "");
  if (!/^(?:api\/v3\/)?repos\/[^/]+\/[^/]+\/pulls\/?$/.test(path)) return false;
  // gh api defaults to POST once parameters are added.
  return method === "POST" || (method === null && hasFields);
}

/** `git push … -o merge_request.create` (GitLab push options). */
function isGitPushMrCreate(args: string[]): boolean {
  if (positionals(args, new Set(["-C", "-c"]))[0] !== "push") return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    let opt: string | null = null;
    if (a === "-o" || a === "--push-option") opt = args[i + 1] ?? "";
    else if (a.startsWith("--push-option=")) opt = a.slice("--push-option=".length);
    else if (a.startsWith("-o") && a.length > 2) opt = a.slice(2);
    if (opt && /^merge_request\.create\b/.test(opt)) return true;
  }
  return false;
}

/** True when one simple command (its words) creates a PR / MR. */
function wordsCreatePr(rawWords: string[], depth: number): boolean {
  const words = commandWords(rawWords);
  if (!words.length) return false;
  const name = basename(words[0]);
  const args = words.slice(1);
  if (SHELLS.has(name)) {
    // bash -c '<script>' / bash -lc '<script>'
    const idx = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
    if (idx >= 0 && args[idx + 1] != null && depth < 4) {
      return countPrCreatingCommands(args[idx + 1], depth + 1) > 0;
    }
    return false;
  }
  switch (name) {
    case "gh": {
      const pos = positionals(args, GH_VALUED);
      if (pos[0] === "pr" && (pos[1] === "create" || pos[1] === "new")) return true;
      if (pos[0] === "api") return isGhApiPrCreate(args.slice(args.indexOf("api") + 1));
      return false;
    }
    case "glab": {
      const pos = positionals(args, GH_VALUED);
      return pos[0] === "mr" && (pos[1] === "create" || pos[1] === "new");
    }
    case "hub": {
      const pos = positionals(args, new Set(["-C"]));
      return pos[0] === "pull-request";
    }
    case "git":
      return isGitPushMrCreate(args);
    case "aws": {
      const pos = positionals(args, AWS_VALUED);
      return pos[0] === "codecommit" && pos[1] === "create-pull-request";
    }
    default:
      return false;
  }
}

function countPrCreatingCommands(script: string, depth: number): number {
  let n = 0;
  for (const words of splitShellCommands(script)) {
    if (wordsCreatePr(words, depth)) n++;
  }
  return n;
}

/** How many PR-creating commands a shell script runs (anywhere in a compound command). */
export function prCreatingCommandCount(cmd: string): number {
  return countPrCreatingCommands(cmd, 0);
}

/** True when a shell command creates a PR / MR anywhere in it. */
export function prCreatingCommand(cmd: string): boolean {
  return prCreatingCommandCount(cmd) > 0;
}

// ── Tool calls ──────────────────────────────────────────────────────────────

/** `mcp__github__create_pull_request`, `github.create_pull_request`, `create_merge_request`, … */
export function prCreatingMcpTool(toolName: string): boolean {
  const last = toolName.split(/__|[./:]/).pop() ?? "";
  const norm = last.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  return norm === "create_pull_request" || norm === "create_merge_request";
}

/** A shell tool's command, from its input: `{ command }` / `{ cmd }` (string or argv), a JSON string, or the raw command. */
export function shellCommandFromInput(input: unknown): string | null {
  if (input == null) return null;
  if (typeof input === "string") {
    const t = input.trim();
    if (t.startsWith("{")) {
      try {
        return shellCommandFromInput(JSON.parse(t));
      } catch {
        // Bounded (truncated) JSON: dig the command out by hand below.
      }
    }
    // Truncated JSON, or Codex code-mode `tools.exec_command({cmd: "…"})`.
    const m = t.match(/["']?(?:command|cmd)["']?\s*:\s*"((?:[^"\\]|\\.)*)/);
    if (!m) return null;
    try {
      return JSON.parse(`"${m[1]}"`) as string;
    } catch {
      return m[1];
    }
  }
  if (Array.isArray(input)) {
    const argv = input.map(String);
    // ["bash", "-lc", "<script>"] → the script; otherwise quote the argv back together.
    if (argv.length >= 3 && SHELLS.has(basename(argv[0])) && /^-[a-z]*c[a-z]*$/.test(argv[1])) {
      return argv[2];
    }
    return argv
      .map((a) => (/[\s'"$`\\;&|<>()]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a))
      .join(" ");
  }
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    for (const key of ["command", "cmd", "script"]) {
      const v = o[key];
      if (typeof v === "string") return v;
      if (Array.isArray(v)) return shellCommandFromInput(v);
    }
  }
  return null;
}

/** How many PRs a tool call (name + input) creates; 0 when it creates none. */
export function prCreatingToolCallCount(toolName: string, input: unknown): number {
  if (prCreatingMcpTool(toolName)) return 1;
  const cmd = shellCommandFromInput(input);
  return cmd ? prCreatingCommandCount(cmd) : 0;
}

/** True when a tool call (name + input) creates a PR / MR. */
export function isPrCreatingToolCall(toolName: string, input: unknown): boolean {
  return prCreatingToolCallCount(toolName, input) > 0;
}

// ── Results ─────────────────────────────────────────────────────────────────

/** A PR / MR / CodeCommit web URL (not an API URL, not `/pull/new/…`). */
const PR_URL_RE =
  /https?:\/\/(?![\w.-]+\/api\/)(?!api\.)[^\s"'<>()`\\]+?\/(?:pull\/\d+|-\/merge_requests\/\d+|merge_requests\/\d+|pull-requests\/\d+)(?![\w/])/g;

const ALREADY_EXISTS_RE = /already exists/i;

function parseJsonMaybe(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Unwrap an MCP result (`[{type:"text", text:"{…}"}]`, `{content:[…]}`) to its JSON payload. */
function unwrapMcp(value: unknown, depth = 0): unknown {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) {
    const texts = value
      .map((v) =>
        v && typeof v === "object" && typeof (v as any).text === "string" ? (v as any).text : null,
      )
      .filter((t): t is string => t != null);
    if (texts.length) {
      const inner = parseJsonMaybe(texts.join(""));
      return inner === undefined ? texts.join("\n") : unwrapMcp(inner, depth + 1);
    }
    return value;
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (Array.isArray(o.content) && !("html_url" in o) && !("web_url" in o)) {
      return unwrapMcp(o.content, depth + 1);
    }
    if (o.structuredContent && typeof o.structuredContent === "object") {
      return unwrapMcp(o.structuredContent, depth + 1);
    }
  }
  return value;
}

function matchesPrUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  PR_URL_RE.lastIndex = 0;
  const m = url.match(PR_URL_RE);
  return m != null && m[0] === url;
}

/**
 * The PRs a PR-creating call's result names, in order. JSON results (MCP,
 * `gh api`, `aws codecommit`) are read by field — the PR's own `html_url` /
 * `web_url`, never URLs inside its body; plain text (`gh pr create`, a push
 * with `merge_request.create`) yields its PR URLs. At most `limit` (the
 * call's number of creates) are kept, the last ones.
 */
export function prsFromToolResult(
  text: string,
  limit = 1,
): { url: string | null; codecommit: PrToolCallMatch["codecommit"] }[] {
  if (!text) return [];
  const parsed = parseJsonMaybe(text);
  const json = parsed === undefined ? undefined : unwrapMcp(parsed);
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const o = json as Record<string, any>;
    for (const key of ["html_url", "web_url", "url"]) {
      if (matchesPrUrl(o[key])) return [{ url: o[key], codecommit: null }];
    }
    // GraphQL: { data: { createPullRequest: { pullRequest: { url } } } }
    const gql = o.data?.createPullRequest?.pullRequest;
    if (gql && matchesPrUrl(gql.url ?? gql.permalink)) {
      return [{ url: gql.url ?? gql.permalink, codecommit: null }];
    }
    // aws codecommit create-pull-request
    const cc = o.pullRequest;
    if (cc && typeof cc === "object" && cc.pullRequestId != null) {
      const id = parseInt(String(cc.pullRequestId), 10);
      const repositoryName = cc.pullRequestTargets?.[0]?.repositoryName;
      if (Number.isFinite(id) && typeof repositoryName === "string") {
        return [{ url: null, codecommit: { pullRequestId: id, repositoryName } }];
      }
    }
    return [];
  }
  const source = typeof json === "string" ? json : text;
  PR_URL_RE.lastIndex = 0;
  const urls = [...new Set(source.match(PR_URL_RE) ?? [])];
  return urls.slice(-Math.max(1, limit)).map((url) => ({ url, codecommit: null }));
}

/** The PR URL(s) in a tool result (see {@link prsFromToolResult}); URLs only. */
export function prUrlFromToolResult(text: string): string | null {
  return prsFromToolResult(text).find((p) => p.url)?.url ?? null;
}

/**
 * The PRs one call created: nothing unless the call creates PRs and has a
 * result; a failed call counts only when it says the PR already exists
 * (`gh pr create` on a branch that has one).
 */
export function prsFromToolCall(call: ToolCallRecord): PrToolCallMatch[] {
  if (call.result == null) return [];
  const count = prCreatingToolCallCount(call.toolName, call.input);
  if (count === 0) return [];
  const alreadyExisted = ALREADY_EXISTS_RE.test(call.result);
  if (call.isError && !alreadyExisted) return [];
  return prsFromToolResult(call.result, count).map((p) => ({
    ...p,
    toolName: call.toolName,
    alreadyExisted,
  }));
}

/** Every PR a list of calls created, de-duplicated, in order. */
export function prsFromToolCalls(calls: ToolCallRecord[]): PrToolCallMatch[] {
  const out: PrToolCallMatch[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    for (const m of prsFromToolCall(call)) {
      const key =
        m.url ?? `codecommit:${m.codecommit?.repositoryName}:${m.codecommit?.pullRequestId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/** A transcript entry as Optio Local stores it (the fields pairing needs). */
export interface TranscriptToolEntry {
  kind: string;
  text: string;
  detail: string | null;
  toolName: string | null;
  toolUseId: string | null;
  isError: boolean;
}

/** Pair a transcript's `tool_use` / `tool_result` entries by tool-use id and find the PRs they created. */
export function prsFromTranscript(entries: TranscriptToolEntry[]): PrToolCallMatch[] {
  const calls = new Map<string, ToolCallRecord>();
  const order: ToolCallRecord[] = [];
  for (const e of entries) {
    if (!e.toolUseId) continue;
    if (e.kind === "tool_use") {
      const toolName = e.toolName ?? "";
      // The detail is the call's input; a shell call whose input can't be
      // read (code mode, clipped) still has its command as the summary text.
      const cmd = shellCommandFromInput(e.detail);
      const input =
        cmd != null
          ? { command: cmd }
          : /^(shell|bash|exec_command|local_shell)$/i.test(toolName)
            ? { command: e.text }
            : e.detail;
      const rec: ToolCallRecord = {
        toolName,
        input,
        result: null,
        isError: false,
      };
      calls.set(e.toolUseId, rec);
      order.push(rec);
    } else if (e.kind === "tool_result") {
      const rec = calls.get(e.toolUseId);
      if (rec && rec.result == null) {
        rec.result = e.text;
        rec.isError = e.isError;
      }
    }
  }
  return prsFromToolCalls(order);
}

// ── Event streams ───────────────────────────────────────────────────────────

function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c: any) => (typeof c === "string" ? c : (c?.text ?? c?.content ?? "")))
      .join("");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

/**
 * Follows an agent's event stream (Claude Code stream-json, Codex
 * `exec --json`), pairing PR-creating calls with their results by id.
 * Each `ingest*` call returns the PRs the line's results created.
 */
export class PrToolCallTracker {
  private pending = new Map<string, { toolName: string; input: unknown }>();
  private seen = new Set<string>();
  readonly matches: PrToolCallMatch[] = [];

  /** A tool call started. Only PR-creating calls are remembered. */
  call(id: string | null | undefined, toolName: string, input: unknown): void {
    if (!id || !isPrCreatingToolCall(toolName, input)) return;
    this.pending.set(id, { toolName, input });
  }

  /** A tool call finished. */
  result(id: string | null | undefined, text: string, isError: boolean): PrToolCallMatch[] {
    if (!id) return [];
    const call = this.pending.get(id);
    if (!call) return [];
    this.pending.delete(id);
    return this.record(prsFromToolCall({ ...call, result: text, isError }));
  }

  /** A call and its result in one event (Codex `item.completed`). */
  completed(toolName: string, input: unknown, text: string, isError: boolean): PrToolCallMatch[] {
    return this.record(prsFromToolCall({ toolName, input, result: text, isError }));
  }

  private record(found: PrToolCallMatch[]): PrToolCallMatch[] {
    const fresh: PrToolCallMatch[] = [];
    for (const m of found) {
      const key =
        m.url ?? `codecommit:${m.codecommit?.repositoryName}:${m.codecommit?.pullRequestId}`;
      if (this.seen.has(key)) continue;
      this.seen.add(key);
      fresh.push(m);
      this.matches.push(m);
    }
    return fresh;
  }

  /** One line of Claude Code `--output-format stream-json`. */
  ingestClaudeLine(line: string): PrToolCallMatch[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    const blocks = event?.message?.content;
    if (!Array.isArray(blocks)) return [];
    const found: PrToolCallMatch[] = [];
    for (const block of blocks) {
      if (block?.type === "tool_use") this.call(block.id, block.name ?? "", block.input);
      else if (block?.type === "tool_result") {
        found.push(...this.result(block.tool_use_id, resultText(block.content), !!block.is_error));
      }
    }
    return found;
  }

  /** One line of `codex exec --json` (current `item.*` events and the older function-call events). */
  ingestCodexLine(line: string): PrToolCallMatch[] {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return [];
    }
    if (!event || typeof event !== "object") return [];
    if (event.type === "item.completed" && event.item) {
      const item = event.item;
      if (item.type === "command_execution") {
        const failed = item.status === "failed" || (item.exit_code != null && item.exit_code !== 0);
        return this.completed(
          "shell",
          { command: item.command },
          String(item.aggregated_output ?? ""),
          failed,
        );
      }
      if (item.type === "mcp_tool_call") {
        const name = `${item.server ?? "mcp"}__${item.tool ?? ""}`;
        const text =
          item.result != null
            ? resultText(item.result.content ?? item.result)
            : String(item.error?.message ?? "");
        return this.completed(name, item.arguments, text, item.status === "failed" || !!item.error);
      }
      return [];
    }
    if (event.type === "function_call") {
      let args: unknown = event.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          // keep the string
        }
      }
      this.call(event.call_id, event.name ?? "", args);
      return [];
    }
    if (event.type === "function_call_output") {
      const out = event.output;
      let text = typeof out === "string" ? out : resultText(out);
      let isError = false;
      // { output, metadata: { exit_code } } wrapped as a JSON string
      const parsed = parseJsonMaybe(text);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "output" in (parsed as any)
      ) {
        const p = parsed as any;
        text = String(p.output ?? "");
        const code = p.metadata?.exit_code;
        isError = code != null && code !== 0;
      }
      return this.result(event.call_id, text, isError);
    }
    return [];
  }
}
