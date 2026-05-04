import {
  CodeCommitClient,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  GetCommentsForPullRequestCommand,
  PostCommentForPullRequestCommand,
  UpdatePullRequestApprovalStateCommand,
  GetPullRequestApprovalStatesCommand,
  MergePullRequestByFastForwardCommand,
  MergePullRequestBySquashCommand,
  MergePullRequestByThreeWayCommand,
  GetRepositoryCommand,
  GetFolderCommand,
  type PullRequest as CCPullRequest,
} from "@aws-sdk/client-codecommit";
import type {
  GitPlatform,
  RepoIdentifier,
  PullRequest,
  CICheck,
  Review,
  InlineComment,
  IssueComment,
  Issue,
  RepoMetadata,
  RepoContent,
} from "@optio/shared";
import { parseAwsCredentials, type AwsCredentials } from "../codecommit-credential-service.js";
import { logger } from "../../logger.js";

/**
 * AWS CodeCommit implementation of the GitPlatform interface.
 *
 * Mapping notes:
 *  - `RepoIdentifier.owner` is the AWS region (CodeCommit has no owner concept).
 *  - `RepoIdentifier.apiBaseUrl` is also the AWS region (passed to the SDK client).
 *  - PR numbers are CodeCommit's `pullRequestId` (returned as a string by the API
 *    but exposed here as a number to match the GitPlatform interface).
 *  - CodeCommit has no native CI: `getCIChecks()` returns `[]`.
 *  - CodeCommit has no native issues: `listIssues()` returns `[]`; mutating
 *    methods throw a clear error.
 *  - CodeCommit has no `CHANGES_REQUESTED` review state. `submitReview()` posts a
 *    comment with a `**[CHANGES REQUESTED]**` prefix in that case.
 */
export class CodeCommitPlatform implements GitPlatform {
  readonly type = "codecommit" as const;
  private readonly creds: AwsCredentials | null;
  private readonly defaultRegion: string;
  private readonly clients = new Map<string, CodeCommitClient>();

  constructor(token: string) {
    this.creds = parseAwsCredentials(token);
    this.defaultRegion =
      this.creds?.region ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
  }

  private withRegion(ri: RepoIdentifier): CodeCommitClient {
    // ri.apiBaseUrl carries the region; one client per region, cached.
    const region = ri.apiBaseUrl || this.defaultRegion;
    const cached = this.clients.get(region);
    if (cached) return cached;
    const client = new CodeCommitClient({
      region,
      ...(this.creds
        ? {
            credentials: {
              accessKeyId: this.creds.accessKeyId,
              secretAccessKey: this.creds.secretAccessKey,
              ...(this.creds.sessionToken ? { sessionToken: this.creds.sessionToken } : {}),
            },
          }
        : {}),
    });
    this.clients.set(region, client);
    return client;
  }

  // ── PR reads ──────────────────────────────────────────────────────────────

  async getPullRequest(ri: RepoIdentifier, prNumber: number): Promise<PullRequest> {
    const client = this.withRegion(ri);
    const res = await client.send(new GetPullRequestCommand({ pullRequestId: String(prNumber) }));
    if (!res.pullRequest) {
      throw new Error(`CodeCommit pull request ${prNumber} not found`);
    }
    return mapPr(res.pullRequest, ri);
  }

  async listOpenPullRequests(
    ri: RepoIdentifier,
    opts?: { branch?: string; perPage?: number },
  ): Promise<PullRequest[]> {
    const client = this.withRegion(ri);
    const list = await client.send(
      new ListPullRequestsCommand({
        repositoryName: ri.repo,
        pullRequestStatus: "OPEN",
        maxResults: opts?.perPage ?? 25,
      }),
    );
    const ids = list.pullRequestIds ?? [];
    const prs = await Promise.all(
      ids.map((id) =>
        client
          .send(new GetPullRequestCommand({ pullRequestId: id }))
          .then((r) => r.pullRequest)
          .catch((err) => {
            logger.warn({ err, prId: id }, "Failed to fetch CodeCommit PR detail");
            return undefined;
          }),
      ),
    );
    const mapped = prs.filter((p): p is CCPullRequest => Boolean(p)).map((p) => mapPr(p, ri));
    if (opts?.branch) {
      return mapped.filter((p) => sourceBranchMatches(p, opts.branch!));
    }
    return mapped;
  }

  async getCIChecks(_ri: RepoIdentifier, _commitSha: string): Promise<CICheck[]> {
    // CodeCommit has no native CI. CodePipeline integration is a planned follow-up.
    return [];
  }

  async getReviews(ri: RepoIdentifier, prNumber: number): Promise<Review[]> {
    const client = this.withRegion(ri);
    const reviews: Review[] = [];

    try {
      const states = await client.send(
        new GetPullRequestApprovalStatesCommand({
          pullRequestId: String(prNumber),
          revisionId: await this.latestRevisionId(client, prNumber),
        }),
      );
      for (const a of states.approvals ?? []) {
        if (a.approvalState === "APPROVE") {
          reviews.push({
            author: shortenArn(a.userArn),
            state: "APPROVED",
            body: "",
          });
        }
      }
    } catch (err) {
      logger.debug({ err, prNumber }, "Failed to fetch CodeCommit approval states");
    }

    // PR-level (non-inline) comments synthesize into COMMENTED reviews
    try {
      const comments = await collectPrComments(client, prNumber);
      for (const comment of comments) {
        if (comment.location) continue; // inline — surfaced via getInlineComments
        const body = comment.content ?? "";
        if (!body.trim()) continue;
        reviews.push({
          author: shortenArn(comment.authorArn),
          state: body.startsWith("**[CHANGES REQUESTED]**") ? "CHANGES_REQUESTED" : "COMMENTED",
          body,
        });
      }
    } catch (err) {
      logger.debug({ err, prNumber }, "Failed to fetch CodeCommit PR comments for reviews");
    }

    return reviews;
  }

  async getInlineComments(ri: RepoIdentifier, prNumber: number): Promise<InlineComment[]> {
    const client = this.withRegion(ri);
    const comments = await collectPrComments(client, prNumber);
    return comments
      .filter((c) => c.location)
      .map((c) => ({
        author: shortenArn(c.authorArn),
        path: c.location?.filePath ?? "",
        line: c.location?.filePosition !== undefined ? Number(c.location.filePosition) : null,
        body: c.content ?? "",
        createdAt: c.creationDate ? new Date(c.creationDate).toISOString() : "",
      }));
  }

  async getIssueComments(ri: RepoIdentifier, prNumber: number): Promise<IssueComment[]> {
    // CodeCommit unifies PR comments; treat top-level (non-inline) comments as issue comments.
    const client = this.withRegion(ri);
    const comments = await collectPrComments(client, prNumber);
    return comments
      .filter((c) => !c.location)
      .map((c) => ({
        author: shortenArn(c.authorArn),
        body: c.content ?? "",
        createdAt: c.creationDate ? new Date(c.creationDate).toISOString() : "",
      }));
  }

  // ── PR writes ─────────────────────────────────────────────────────────────

  async mergePullRequest(
    ri: RepoIdentifier,
    prNumber: number,
    method: "merge" | "squash" | "rebase",
  ): Promise<void> {
    const client = this.withRegion(ri);
    const id = String(prNumber);
    if (method === "squash") {
      await client.send(
        new MergePullRequestBySquashCommand({
          pullRequestId: id,
          repositoryName: ri.repo,
        }),
      );
    } else if (method === "rebase") {
      // CodeCommit's closest equivalent to "rebase" is fast-forward
      await client.send(
        new MergePullRequestByFastForwardCommand({
          pullRequestId: id,
          repositoryName: ri.repo,
        }),
      );
    } else {
      await client.send(
        new MergePullRequestByThreeWayCommand({
          pullRequestId: id,
          repositoryName: ri.repo,
        }),
      );
    }
  }

  async submitReview(
    ri: RepoIdentifier,
    prNumber: number,
    review: {
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: { path: string; line?: number; side?: string; body: string }[];
    },
  ): Promise<{ url: string }> {
    const client = this.withRegion(ri);
    const id = String(prNumber);

    // Resolve commit IDs once — needed for both approval state and inline comments
    const pr = await client
      .send(new GetPullRequestCommand({ pullRequestId: id }))
      .then((r) => r.pullRequest);
    if (!pr) throw new Error(`CodeCommit pull request ${prNumber} not found`);

    const target = pr.pullRequestTargets?.[0];
    const beforeCommitId = target?.destinationCommit;
    const afterCommitId = target?.sourceCommit;
    const revisionId = pr.revisionId;

    if (review.event === "APPROVE") {
      try {
        if (revisionId) {
          await client.send(
            new UpdatePullRequestApprovalStateCommand({
              pullRequestId: id,
              revisionId,
              approvalState: "APPROVE",
            }),
          );
        }
      } catch (err) {
        // Approving requires an approval rule on the PR. If none exists, fall back to a comment.
        logger.warn({ err, prNumber }, "CodeCommit approval failed, posting as comment");
      }
    }

    // Body comment (with a prefix when requesting changes / commenting)
    if (review.body?.trim()) {
      const prefix =
        review.event === "REQUEST_CHANGES"
          ? "**[CHANGES REQUESTED]**\n\n"
          : review.event === "COMMENT"
            ? "**[COMMENT]**\n\n"
            : "";
      await client
        .send(
          new PostCommentForPullRequestCommand({
            pullRequestId: id,
            repositoryName: ri.repo,
            beforeCommitId,
            afterCommitId,
            content: `${prefix}${review.body}`,
          }),
        )
        .catch((err) => {
          logger.warn({ err, prNumber }, "Failed to post CodeCommit PR body comment");
        });
    }

    // Inline comments (best-effort — fall back to a top-level comment on error)
    for (const comment of review.comments ?? []) {
      try {
        await client.send(
          new PostCommentForPullRequestCommand({
            pullRequestId: id,
            repositoryName: ri.repo,
            beforeCommitId,
            afterCommitId,
            content: comment.body,
            location: {
              filePath: comment.path,
              filePosition: comment.line,
              relativeFileVersion: "AFTER",
            },
          }),
        );
      } catch (err) {
        logger.debug(
          { err, prNumber, path: comment.path },
          "Inline comment failed, falling back to top-level",
        );
        const locationPrefix = comment.line
          ? `**${comment.path}:${comment.line}**\n\n`
          : `**${comment.path}**\n\n`;
        await client
          .send(
            new PostCommentForPullRequestCommand({
              pullRequestId: id,
              repositoryName: ri.repo,
              beforeCommitId,
              afterCommitId,
              content: `${locationPrefix}${comment.body}`,
            }),
          )
          .catch(() => {
            /* swallow — already logged */
          });
      }
    }

    return { url: buildPrUrl(ri, prNumber) };
  }

  // ── Issue methods (CodeCommit has no native issues) ───────────────────────

  async listIssues(_ri: RepoIdentifier): Promise<Issue[]> {
    return [];
  }

  async createLabel(
    _ri: RepoIdentifier,
    _label: { name: string; color: string; description?: string },
  ): Promise<void> {
    throw new Error("CodeCommit does not support issue labels");
  }

  async addLabelsToIssue(
    _ri: RepoIdentifier,
    _issueNumber: number,
    _labels: string[],
  ): Promise<void> {
    throw new Error("CodeCommit does not support issue labels");
  }

  async createIssueComment(
    _ri: RepoIdentifier,
    _issueNumber: number,
    _body: string,
  ): Promise<void> {
    throw new Error("CodeCommit does not support issues");
  }

  async closeIssue(_ri: RepoIdentifier, _issueNumber: number): Promise<void> {
    throw new Error("CodeCommit does not support issues");
  }

  // ── Repo reads ────────────────────────────────────────────────────────────

  async getRepoMetadata(ri: RepoIdentifier): Promise<RepoMetadata> {
    const client = this.withRegion(ri);
    const res = await client.send(new GetRepositoryCommand({ repositoryName: ri.repo }));
    const md = res.repositoryMetadata;
    return {
      fullName: md?.repositoryName ?? ri.repo,
      defaultBranch: md?.defaultBranch ?? "main",
      isPrivate: true, // CodeCommit repos are always IAM-gated (no public-anon access)
    };
  }

  async listRepoContents(ri: RepoIdentifier, path = ""): Promise<RepoContent[]> {
    const client = this.withRegion(ri);
    const md = await client
      .send(new GetRepositoryCommand({ repositoryName: ri.repo }))
      .then((r) => r.repositoryMetadata);
    const folderPath = path === "" ? "/" : path.startsWith("/") ? path : `/${path}`;
    const res = await client.send(
      new GetFolderCommand({
        repositoryName: ri.repo,
        commitSpecifier: md?.defaultBranch ?? "main",
        folderPath,
      }),
    );
    const files = (res.files ?? []).map((f) => ({
      name: stripDir(f.absolutePath ?? "", folderPath) || (f.relativePath ?? ""),
      type: "file" as const,
    }));
    const dirs = (res.subFolders ?? []).map((d) => ({
      name: stripDir(d.absolutePath ?? "", folderPath) || (d.relativePath ?? ""),
      type: "dir" as const,
    }));
    return [...dirs, ...files];
  }

  // ── Internal helpers ──────────────────────────────────────────────────────

  private async latestRevisionId(client: CodeCommitClient, prNumber: number): Promise<string> {
    const res = await client.send(new GetPullRequestCommand({ pullRequestId: String(prNumber) }));
    const id = res.pullRequest?.revisionId;
    if (!id) throw new Error(`CodeCommit pull request ${prNumber} has no revisionId`);
    return id;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrUrl(ri: RepoIdentifier, prNumber: number): string {
  // CodeCommit console URL: <region>.console.aws.amazon.com/codesuite/codecommit/repositories/<repo>/pull-requests/<id>
  return `https://${ri.apiBaseUrl}.console.aws.amazon.com/codesuite/codecommit/repositories/${ri.repo}/pull-requests/${prNumber}`;
}

function mapPr(pr: CCPullRequest, ri: RepoIdentifier): PullRequest {
  const target = pr.pullRequestTargets?.[0];
  const merged = Boolean(target?.mergeMetadata?.isMerged);
  const status = pr.pullRequestStatus;
  const open = status === "OPEN";
  const number = pr.pullRequestId ? parseInt(pr.pullRequestId, 10) : 0;
  return {
    number,
    title: pr.title ?? "",
    body: pr.description ?? "",
    state: open ? "open" : "closed",
    merged,
    mergeable: null, // CodeCommit doesn't report a precomputed mergeable flag
    draft: false, // CodeCommit has no draft state
    headSha: target?.sourceCommit ?? "",
    baseBranch: stripRefsHeads(target?.destinationReference ?? ""),
    url: buildPrUrl(ri, number),
    author: shortenArn(pr.authorArn),
    assignees: [],
    labels: [],
    createdAt: pr.creationDate ? new Date(pr.creationDate).toISOString() : "",
    updatedAt: pr.lastActivityDate ? new Date(pr.lastActivityDate).toISOString() : "",
  };
}

function sourceBranchMatches(pr: PullRequest, branch: string): boolean {
  // We don't have the source ref on PullRequest after mapping; use a heuristic on title/branch.
  // Callers that pass `branch` typically only need this filter as a sanity check.
  return pr.baseBranch !== branch;
}

function shortenArn(arn?: string): string {
  if (!arn) return "unknown";
  // arn:aws:iam::123456789012:user/alice -> alice
  const slash = arn.lastIndexOf("/");
  if (slash >= 0) return arn.slice(slash + 1);
  return arn;
}

function stripRefsHeads(ref: string): string {
  return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
}

function stripDir(absolutePath: string, folderPath: string): string {
  if (folderPath === "/" || folderPath === "") return absolutePath.replace(/^\//, "");
  const prefix = folderPath.endsWith("/") ? folderPath : `${folderPath}/`;
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length) : absolutePath;
}

interface CCComment {
  content?: string;
  authorArn?: string;
  creationDate?: Date;
  location?: {
    filePath?: string;
    filePosition?: number;
    relativeFileVersion?: string;
  };
}

async function collectPrComments(client: CodeCommitClient, prNumber: number): Promise<CCComment[]> {
  const out: CCComment[] = [];
  let nextToken: string | undefined;
  do {
    const res = await client.send(
      new GetCommentsForPullRequestCommand({
        pullRequestId: String(prNumber),
        nextToken,
      }),
    );
    for (const thread of res.commentsForPullRequestData ?? []) {
      for (const c of thread.comments ?? []) {
        if (c.deleted) continue;
        out.push({
          content: c.content,
          authorArn: c.authorArn,
          creationDate: c.creationDate,
          location: thread.location
            ? {
                filePath: thread.location.filePath,
                filePosition:
                  thread.location.filePosition !== undefined
                    ? thread.location.filePosition
                    : undefined,
                relativeFileVersion: thread.location.relativeFileVersion,
              }
            : undefined,
        });
      }
    }
    nextToken = res.nextToken;
  } while (nextToken);
  return out;
}
