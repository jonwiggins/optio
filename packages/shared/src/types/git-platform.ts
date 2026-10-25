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
  /**
   * The platform's own merge status, when it reports one (GitLab's
   * `detailed_merge_status`: "unchecked", "checking", "mergeable", …).
   */
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

/**
 * A project webhook as Optio wants it: where the platform delivers, the
 * shared token it sends back with every delivery, and which of the
 * platform's own event names it subscribes to (GitHub: `push`,
 * `pull_request`, `issue_comment`, …; GitLab: `push`, `merge_requests`,
 * `note`, `pipeline`, `issues`, `releases`).
 */
export interface WebhookSpec {
  url: string;
  token: string;
  events: string[];
  /**
   * Whether the platform verifies the receiver's TLS certificate. Unset
   * means the platform's default (GitLab: the deployment's
   * `OPTIO_GITLAB_HOOK_SSL_VERIFY`, on unless it trusts a private CA).
   */
  sslVerify?: boolean;
}

export interface GitPlatform {
  readonly type: GitPlatformType;

  // Webhooks. Only a platform that can register Optio's receiver on a
  // project implements these (GitHub, GitLab); the others leave them out,
  // and the repo webhook service reports that the platform cannot.
  /**
   * Make the project's webhook to `spec.url` exist with these settings:
   * found by URL, created when missing, else brought up to date (the token
   * is never readable, so an existing hook is always rewritten).
   */
  ensureWebhook?(
    ri: RepoIdentifier,
    spec: WebhookSpec,
  ): Promise<{ hookId: string; created: boolean }>;
  /** Remove a webhook `ensureWebhook` made; one already gone is not an error. */
  deleteWebhook?(ri: RepoIdentifier, hookId: string): Promise<void>;

  // PR/MR reads
  getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest>;
  /**
   * Open PRs / MRs, most recently updated first. `search` narrows them to
   * those whose number (`12`, `#12`, `!12`), title, body, head branch or
   * author contains it — server-side where the platform can, else over the
   * page it fetched. `branch` keeps only those from that head branch.
   */
  listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number; search?: string },
  ): Promise<PullRequest[]>;
  /**
   * Open PRs whose head branch starts with `prefix` (e.g. `optio/task-<id>`),
   * newest pages first, bounded. Platforms that can't filter return [].
   */
  findPullRequestsByHeadPrefix(ri: RepoIdentifier, prefix: string): Promise<PullRequest[]>;
  getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]>;
  getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]>;
  getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]>;
  getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]>;
  /**
   * The PR / MR's general discussion (comments not on a line of the diff),
   * oldest first. Only a platform whose MR numbers are not issue numbers
   * implements it (GitLab: MR !7 and issue #7 are different threads); for
   * the others `getIssueComments` with the PR number answers.
   */
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
      /**
       * The head commit the review was made on. GitLab pins an approval to
       * it (an MR that moved since is not approved); others ignore it.
       */
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
  /**
   * The repo's branches, the default branch first, narrowed to names that
   * contain `search` when given; at most `perPage` (the platform's own cap
   * applies). Platforms without a branch listing return [].
   */
  listBranches(ri: RepoIdentifier, opts?: { search?: string; perPage?: number }): Promise<Branch[]>;

  /**
   * The repositories these credentials can reach, newest activity first,
   * narrowed to those whose name / path / description matches `query`
   * (server-side where the platform can), at most `perPage` (50 by
   * default). Only platforms with a "my repositories" listing implement it
   * (GitHub, GitLab); `GET /api/repos/browse` reports the others.
   */
  browseRepositories?(
    query: string,
    at: PlatformLocation,
    opts?: { perPage?: number },
  ): Promise<BrowsableRepository[]>;
}
