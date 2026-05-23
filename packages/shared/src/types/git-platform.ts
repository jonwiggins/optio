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
  draft: boolean;
  headSha: string;
  baseBranch: string;
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

export interface GitPlatform {
  readonly type: GitPlatformType;

  // PR/MR reads
  getPullRequest(ri: RepoIdentifier, number: number): Promise<PullRequest>;
  listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number },
  ): Promise<PullRequest[]>;
  getCIChecks(ri: RepoIdentifier, commitSha: string): Promise<CICheck[]>;
  getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]>;
  getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]>;
  getIssueComments(ri: RepoIdentifier, issueOrPrNumber: number): Promise<IssueComment[]>;

  // PR/MR writes
  mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<void>;
  submitReview(
    ri: RepoIdentifier,
    prNumber: number,
    review: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
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
}
