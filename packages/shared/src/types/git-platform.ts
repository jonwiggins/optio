export type GitPlatformType = "github" | "gitlab" | "codecommit";

export interface RepoIdentifier {
  platform: GitPlatformType;
  host: string; // "github.com", "gitlab.com", "gitlab.myco.com", "git-codecommit.us-east-1.amazonaws.com"
  owner: string; // For CodeCommit: AWS region (e.g. "us-east-1") since CodeCommit has no owner concept
  repo: string;
  apiBaseUrl: string; // "https://api.github.com", "https://gitlab.com/api/v4", or AWS region for CodeCommit
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  merged: boolean;
  mergeable: boolean | null;
  /** GitLab detailed_merge_status. */
  mergeStatus?: string;
  draft: boolean;
  headSha: string;
  baseBranch: string;
  /** The PR's head / source branch, when the platform reports it. */
  headBranch?: string;
  /** `owner/repo` the head branch lives in (differs from the base repo for a fork), when known. */
  headRepo?: string;
  url: string;
  author: string;
  assignees: string[];
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CICheck {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "skipped" | "cancelled" | null;
}

export interface Review {
  author: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  body: string;
}

export interface InlineComment {
  author: string;
  path: string;
  line: number | null;
  body: string;
  createdAt: string;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  url: string;
  labels: string[];
  author: string;
  assignee: string | null;
  isPullRequest: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RepoMetadata {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface RepoContent {
  name: string;
  type: "file" | "dir";
}

/**
 * A repository the platform credentials can reach, as the "Add repository"
 * picker lists it (`GitPlatform.browseRepositories`).
 */
export interface BrowsableRepository {
  /** `owner/name` (GitLab: the project's full path, groups included). */
  fullName: string;
  cloneUrl: string;
  htmlUrl: string;
  defaultBranch: string;
  isPrivate: boolean;
  description: string | null;
  /** When it last changed (GitHub: last push; GitLab: last activity). */
  pushedAt: string | null;
}

/** Where on a platform `browseRepositories` looks: its host and its API root. */
export interface PlatformLocation {
  host: string;
  apiBaseUrl: string;
}

/** A branch of a repository, as the branch pickers list them. */
export interface Branch {
  name: string;
  /** The repository's default branch (what `getRepoMetadata` reports). */
  default: boolean;
  protected?: boolean;
}

export interface GitPlatform {
  readonly type: GitPlatformType;

  // PR/MR reads
  getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest>;
  listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number },
  ): Promise<PullRequest[]>;
  /**
   * Open PRs whose head branch starts with `prefix` (e.g. `optio/task-<id>`),
   * newest pages first, bounded. Platforms that can't filter return [].
   */
  findPullRequestsByHeadPrefix(ri: RepoIdentifier, prefix: string): Promise<PullRequest[]>;
  getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]>;
  /**
   * The PR's reviews, oldest first. `all`: every page on GitHub (the
   * guarded auto-merge re-reads them before merging); GitLab and CodeCommit
   * ignore it and read what they always do. Otherwise the first page.
   */
  getReviews(ri: RepoIdentifier, prNumber: number, opts?: { all?: boolean }): Promise<Review[]>;
  getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]>;
  getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]>;
  /** One issue by number (on GitHub a PR answers here too, `isPullRequest`). Platforms without issues leave it out. */
  getIssue?(ri: RepoIdentifier, number: number): Promise<Issue>;

  /** The MR discussion, separate from issues on GitLab. */
  getPullRequestComments?(ri: RepoIdentifier, prNumber: number): Promise<IssueComment[]>;

  // PR/MR writes
  mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
    /** Only merge if the source branch still points to this checked commit. */
    expectedHeadSha?: string,
  ): Promise<void>;
  submitReview(
    ri: RepoIdentifier,
    prNumber: number,
    review: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
      /** Pin the approval to the commit reviewed. */
      commitId?: string;
    },
  ): Promise<{ url: string }>;

  // Issue reads/writes
  listIssues(
    ri: RepoIdentifier,
    opts?: { state?: string; perPage?: number; labels?: string },
  ): Promise<Issue[]>;
  createLabel(
    ri: RepoIdentifier,
    label: { name: string; color: string; description?: string },
  ): Promise<void>;
  addLabelsToIssue(ri: RepoIdentifier, issueNumber: number, labels: string[]): Promise<void>;
  createIssueComment(ri: RepoIdentifier, issueNumber: number, body: string): Promise<void>;
  closeIssue(ri: RepoIdentifier, issueNumber: number): Promise<void>;

  // Repo reads
  getRepoMetadata(ri: RepoIdentifier): Promise<RepoMetadata>;
  listRepoContents(ri: RepoIdentifier, path?: string): Promise<RepoContent[]>;
  listBranches(ri: RepoIdentifier, opts?: { search?: string; perPage?: number }): Promise<Branch[]>;
  browseRepositories?(
    query: string,
    at: PlatformLocation,
    opts?: { perPage?: number },
  ): Promise<BrowsableRepository[]>;
}
