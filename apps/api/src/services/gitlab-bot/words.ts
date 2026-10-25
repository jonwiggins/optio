/**
 * The words a bot's reply or prompt uses for its platform (docs/gitlab-bot.md):
 * GitLab's merge requests and pipelines, GitHub's pull requests and CI runs.
 * GitLab's are the default, so the GitLab bot's words are as they were.
 */
export interface ThreadWords {
  platform: "GitHub" | "GitLab";
  /** "merge request" / "pull request". */
  mr: string;
  /** How a merge or pull request is referred to: `!12` / `#12`. */
  ref: (n: number) => string;
  /** "pipeline" / "CI run". */
  pipeline: string;
  /** Whose role allows a change: "at least the Developer role" / "write access". */
  role: string;
  /** The label CI prompts use (resume-prompts.ts `ciFailurePrompt`): MR or PR. */
  ciLabel: "MR" | "PR";
}

export const GITLAB_WORDS: ThreadWords = {
  platform: "GitLab",
  mr: "merge request",
  ref: (n) => `!${n}`,
  pipeline: "pipeline",
  role: "at least the Developer role",
  ciLabel: "MR",
};

export const GITHUB_WORDS: ThreadWords = {
  platform: "GitHub",
  mr: "pull request",
  ref: (n) => `#${n}`,
  pipeline: "CI run",
  role: "write access",
  ciLabel: "PR",
};

export function wordsFor(platform: string | null | undefined): ThreadWords {
  return platform === "github" ? GITHUB_WORDS : GITLAB_WORDS;
}
