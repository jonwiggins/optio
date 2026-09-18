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
    // and stops at the first non-matching char, so the id stays intact.
    scan(text.replace(/\r?\n[ \t]*/g, ""), found);
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
