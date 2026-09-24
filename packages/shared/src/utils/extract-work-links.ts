/**
 * Find PR / ticket links in terminal output so a session can be located by
 * the work it touches. Provider-specific patterns only (never generic URLs):
 * a badge must mean "this PR" or "this ticket", not "some link scrolled by".
 *
 * TUIs (Claude Code, Ink apps) hard-wrap long lines, so a URL can be split
 * across a newline + indentation. Text is scanned twice — as-is and with
 * `\n<indent>` sequences removed — and the results are unioned by URL.
 */

/** `ref` = a bare `#123` resolved against the terminal's repo (PR or issue — the host redirects). */
export type WorkLinkKind = "pr" | "issue" | "ref";
export type WorkLinkProvider = "github" | "gitlab" | "linear" | "jira";

export interface WorkLink {
  url: string;
  kind: WorkLinkKind;
  provider: WorkLinkProvider;
  /** Short display form, e.g. `owner/repo#123`, `group/proj!45`, `ENG-12`. */
  label: string;
}

export const MAX_WORK_LINKS = 50;
/** Bare `#N` references are noisier than URLs — keep fewer of them. */
export const MAX_WORK_REFS = 12;

/**
 * URLs carried in OSC 8 terminal hyperlinks (`ESC ] 8 ; params ; URL BEL|ST`).
 * Claude Code, gh, and most modern CLIs print PR numbers as hyperlinks whose
 * URL exists only inside the escape sequence — an ANSI stripper discards it
 * along with the sequence, so harvest before stripping.
 */
export function extractHyperlinkUrls(raw: string): string[] {
  const out: string[] = [];
  const re = /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]+)(?:\x07|\x1b\\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) out.push(m[1]);
  return out;
}

interface Pattern {
  re: RegExp;
  build: (m: RegExpExecArray) => WorkLink;
}

const GITHUB_RE = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d+)/g;
const GITLAB_RE = /https?:\/\/([\w.-]+)\/([\w.\-/]+?)\/-\/(merge_requests|issues)\/(\d+)/g;
const LINEAR_RE = /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]*-\d+)/g;
const JIRA_RE = /https?:\/\/([\w.-]+)\/browse\/([A-Z][A-Z0-9]*-\d+)/g;

const PATTERNS: Pattern[] = [
  {
    re: GITHUB_RE,
    build: (m) => ({
      url: `https://github.com/${m[1]}/${m[2]}/${m[3]}/${m[4]}`,
      kind: m[3] === "pull" ? "pr" : "issue",
      provider: "github",
      label: `${m[1]}/${m[2]}#${m[4]}`,
    }),
  },
  {
    re: GITLAB_RE,
    build: (m) => ({
      url: `https://${m[1]}/${m[2]}/-/${m[3]}/${m[4]}`,
      kind: m[3] === "merge_requests" ? "pr" : "issue",
      provider: "gitlab",
      label: `${m[2]}${m[3] === "merge_requests" ? "!" : "#"}${m[4]}`,
    }),
  },
  {
    re: LINEAR_RE,
    build: (m) => ({ url: m[0], kind: "issue", provider: "linear", label: m[1] }),
  },
  {
    re: JIRA_RE,
    build: (m) => ({
      url: `https://${m[1]}/browse/${m[2]}`,
      kind: "issue",
      provider: "jira",
      label: m[2],
    }),
  },
];

function scan(text: string, into: Map<string, WorkLink>): void {
  for (const { re, build } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const link = build(m);
      if (!into.has(link.url)) into.set(link.url, link);
      if (into.size >= MAX_WORK_LINKS) return;
    }
  }
}

export interface ExtractWorkLinksOptions {
  /**
   * Git remote of the terminal's directory. When it is a GitHub / GitLab
   * repo, bare `#123` mentions resolve to that repo (kind `ref`).
   */
  repoUrl?: string;
  /**
   * Columns the text was laid out at. Only a line that runs (nearly) to it
   * is a hard wrap to heal; a short line ends where it ends, so a PR URL at
   * the end of one is never glued to digits opening the next ("…/pull/612"
   * + "19 files changed" is not PR 61219). Unset: every break is healed.
   */
  wrapWidth?: number;
}

/** A hard-wrapped line reaches this close to the layout width (TUIs keep a margin). */
const WRAP_SLACK = 16;

/**
 * The text with hard wraps healed: a line break plus the next line's
 * indentation removed, but only after lines long enough to have wrapped.
 */
function healWraps(text: string, wrapWidth: number | undefined): string {
  if (!wrapWidth) return text.replace(/\r?\n[ \t]*/g, "");
  const minWrapped = Math.max(1, wrapWidth - WRAP_SLACK);
  const lines = text.split(/\r?\n/);
  let out = lines[0] ?? "";
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    out += prev.length >= minWrapped ? lines[i].replace(/^[ \t]*/, "") : `\n${lines[i]}`;
  }
  return out;
}

const BARE_REF_RE = /(^|[\s(\[,])#(\d{1,6})(?=$|[\s).,;:!?\]])/gm;

/** Owner/repo base for bare refs, from a normalized https remote URL. */
function refBase(
  repoUrl: string,
): { base: string; provider: WorkLinkProvider; label: string } | null {
  const m = /^https:\/\/([\w.-]+)\/(.+?)(?:\.git)?\/?$/.exec(repoUrl.trim());
  if (!m) return null;
  const [, host, path] = m;
  if (host === "github.com") {
    return { base: `https://github.com/${path}/issues/`, provider: "github", label: path };
  }
  // GitLab (gitlab.com or self-hosted): /-/issues/N redirects to the MR when it is one.
  if (host.includes("gitlab")) {
    return { base: `https://${host}/${path}/-/issues/`, provider: "gitlab", label: path };
  }
  return null;
}

/** Extract PR/ticket links from (ANSI-stripped) terminal text, first-seen order, deduped by URL. */
export function extractWorkLinks(text: string, opts: ExtractWorkLinksOptions = {}): WorkLink[] {
  const found = new Map<string, WorkLink>();
  scan(text, found);
  if (found.size < MAX_WORK_LINKS && /\r?\n[ \t]*/.test(text)) {
    // Second pass with hard wraps healed. A healed boundary can glue a URL
    // to the next word, but every pattern ends in `\d+` (or a ticket key)
    // and stops at the first non-matching char, so the id stays intact —
    // unless the next line opens with digits, which is why only lines long
    // enough to have wrapped are healed when the width is known.
    scan(healWraps(text, opts.wrapWidth), found);
  }

  const base = opts.repoUrl ? refBase(opts.repoUrl) : null;
  if (base && found.size < MAX_WORK_LINKS) {
    // Numbers already covered by a real URL for this repo don't get a ref twice.
    const covered = new Set(
      [...found.values()]
        .filter((l) => l.provider === base.provider && l.label.startsWith(`${base.label}#`))
        .map((l) => l.label.slice(base.label.length + 1)),
    );
    let refs = 0;
    BARE_REF_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BARE_REF_RE.exec(text)) !== null && refs < MAX_WORK_REFS) {
      const n = m[2];
      if (covered.has(n)) continue;
      const url = `${base.base}${n}`;
      if (found.has(url)) continue;
      found.set(url, { url, kind: "ref", provider: base.provider, label: `#${n}` });
      refs++;
      if (found.size >= MAX_WORK_LINKS) break;
    }
  }
  return [...found.values()].slice(0, MAX_WORK_LINKS);
}

/** Stable identity for change detection (order-sensitive). */
export function workLinksKey(links: WorkLink[]): string {
  return links.map((l) => l.url).join("\n");
}

/**
 * The PR / ticket a link names, however its URL was written. On GitHub a
 * repo's PRs and issues share one set of numbers (`/issues/N` redirects to
 * the PR), and owner / repo are case-insensitive; GitLab keeps merge
 * requests (`!N`) and issues (`#N`) apart; Linear / Jira go by their key.
 */
export function workLinkIdentity(link: WorkLink): string {
  const gh = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:pull|issues)\/(\d+)/i.exec(
    link.url,
  );
  if (gh) return `github:${gh[1].toLowerCase()}/${gh[2].toLowerCase()}#${gh[3]}`;
  const gl = /^https?:\/\/([\w.-]+)\/(.+?)\/-\/(merge_requests|issues)\/(\d+)/i.exec(link.url);
  if (gl) {
    const sep = gl[3].toLowerCase() === "merge_requests" ? "!" : "#";
    return `gitlab:${gl[1].toLowerCase()}/${gl[2].toLowerCase()}${sep}${gl[4]}`;
  }
  if (link.provider === "linear" || link.provider === "jira") {
    return `${link.provider}:${link.label.toUpperCase()}`;
  }
  return link.url.toLowerCase().replace(/\/+$/, "");
}

const KIND_RANK: Record<WorkLinkKind, number> = { pr: 2, issue: 1, ref: 0 };

/**
 * One link per PR / ticket, in first-seen order. When the same one turns up
 * twice (a bare `#607` and later its PR URL, the PR a session was started
 * for and the same PR printed by the agent), the most telling wins: a PR
 * over an issue over a bare ref, then the fuller label (`acme/app#607` over
 * `#607`).
 */
export function dedupeWorkLinks(links: WorkLink[]): WorkLink[] {
  const byId = new Map<string, WorkLink>();
  for (const link of links) {
    const id = workLinkIdentity(link);
    const prev = byId.get(id);
    if (
      !prev ||
      KIND_RANK[link.kind] > KIND_RANK[prev.kind] ||
      (KIND_RANK[link.kind] === KIND_RANK[prev.kind] && link.label.length > prev.label.length)
    ) {
      // Map keeps a replaced key where it first appeared.
      byId.set(id, link);
    }
  }
  return [...byId.values()];
}
