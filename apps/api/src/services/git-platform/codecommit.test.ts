import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  CodeCommitClient,
  GetPullRequestCommand,
  ListPullRequestsCommand,
  GetCommentsForPullRequestCommand,
  PostCommentForPullRequestCommand,
  UpdatePullRequestApprovalStateCommand,
  GetPullRequestApprovalStatesCommand,
  MergePullRequestBySquashCommand,
  MergePullRequestByThreeWayCommand,
  GetRepositoryCommand,
  GetFolderCommand,
} from "@aws-sdk/client-codecommit";
import { CodeCommitPlatform } from "./codecommit.js";
import type { RepoIdentifier } from "@optio/shared";

const ri: RepoIdentifier = {
  platform: "codecommit",
  host: "git-codecommit.us-east-1.amazonaws.com",
  owner: "us-east-1",
  repo: "MyRepo",
  apiBaseUrl: "us-east-1",
};

const credToken = JSON.stringify({
  accessKeyId: "AKIA-test",
  secretAccessKey: "secret-test",
  region: "us-east-1",
});

const ccMock = mockClient(CodeCommitClient);

describe("CodeCommitPlatform", () => {
  let platform: CodeCommitPlatform;

  beforeEach(() => {
    ccMock.reset();
    platform = new CodeCommitPlatform(credToken);
  });

  afterEach(() => {
    ccMock.reset();
  });

  it("has type codecommit", () => {
    expect(platform.type).toBe("codecommit");
  });

  describe("getPullRequest", () => {
    it("maps a CodeCommit PR to PullRequest shape", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          pullRequestId: "42",
          title: "Add feature",
          description: "Implements X",
          pullRequestStatus: "OPEN",
          authorArn: "arn:aws:iam::123456789012:user/alice",
          creationDate: new Date("2024-01-01T00:00:00Z"),
          lastActivityDate: new Date("2024-01-02T00:00:00Z"),
          revisionId: "rev1",
          pullRequestTargets: [
            {
              repositoryName: "MyRepo",
              sourceCommit: "abc123",
              destinationCommit: "def456",
              sourceReference: "refs/heads/feature",
              destinationReference: "refs/heads/main",
              mergeMetadata: { isMerged: false },
            },
          ],
        },
      });

      const pr = await platform.getPullRequest(ri, 42);

      expect(pr.number).toBe(42);
      expect(pr.title).toBe("Add feature");
      expect(pr.body).toBe("Implements X");
      expect(pr.state).toBe("open");
      expect(pr.merged).toBe(false);
      expect(pr.headSha).toBe("abc123");
      expect(pr.baseBranch).toBe("main");
      expect(pr.author).toBe("alice");
      expect(pr.url).toBe(
        "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/pull-requests/42",
      );
    });

    it("marks merged PRs as closed + merged", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          pullRequestId: "5",
          title: "t",
          pullRequestStatus: "CLOSED",
          authorArn: "arn:aws:iam::1:user/bob",
          revisionId: "rev",
          pullRequestTargets: [
            {
              sourceCommit: "s",
              destinationReference: "refs/heads/main",
              mergeMetadata: { isMerged: true },
            },
          ],
        },
      });

      const pr = await platform.getPullRequest(ri, 5);
      expect(pr.state).toBe("closed");
      expect(pr.merged).toBe(true);
    });
  });

  describe("listOpenPullRequests", () => {
    it("fetches PR ids and returns mapped PRs", async () => {
      ccMock.on(ListPullRequestsCommand).resolves({ pullRequestIds: ["1", "2"] });
      ccMock
        .on(GetPullRequestCommand, { pullRequestId: "1" })
        .resolves({
          pullRequest: {
            pullRequestId: "1",
            title: "first",
            pullRequestStatus: "OPEN",
            authorArn: "arn:aws:iam::1:user/a",
            revisionId: "r",
            pullRequestTargets: [{ sourceCommit: "x", destinationReference: "refs/heads/main" }],
          },
        })
        .on(GetPullRequestCommand, { pullRequestId: "2" })
        .resolves({
          pullRequest: {
            pullRequestId: "2",
            title: "second",
            pullRequestStatus: "OPEN",
            authorArn: "arn:aws:iam::1:user/b",
            revisionId: "r",
            pullRequestTargets: [{ sourceCommit: "y", destinationReference: "refs/heads/main" }],
          },
        });

      const prs = await platform.listOpenPullRequests(ri);
      expect(prs).toHaveLength(2);
      expect(prs.map((p) => p.number).sort()).toEqual([1, 2]);
    });
  });

  describe("getCIChecks", () => {
    it("returns empty array (CodeCommit has no native CI)", async () => {
      const checks = await platform.getCIChecks(ri, "abc");
      expect(checks).toEqual([]);
    });
  });

  describe("getReviews", () => {
    it("returns APPROVED reviews from approval states", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: { revisionId: "rev1" },
      });
      ccMock.on(GetPullRequestApprovalStatesCommand).resolves({
        approvals: [
          { userArn: "arn:aws:iam::1:user/alice", approvalState: "APPROVE" },
          { userArn: "arn:aws:iam::1:user/bob", approvalState: "REVOKE" },
        ],
      });
      ccMock.on(GetCommentsForPullRequestCommand).resolves({
        commentsForPullRequestData: [],
      });

      const reviews = await platform.getReviews(ri, 42);
      const approvals = reviews.filter((r) => r.state === "APPROVED");
      expect(approvals).toHaveLength(1);
      expect(approvals[0].author).toBe("alice");
    });

    it("synthesizes COMMENTED reviews from non-inline comments", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: { revisionId: "rev1" },
      });
      ccMock.on(GetPullRequestApprovalStatesCommand).resolves({ approvals: [] });
      ccMock.on(GetCommentsForPullRequestCommand).resolves({
        commentsForPullRequestData: [
          {
            comments: [{ content: "looks good", authorArn: "arn:aws:iam::1:user/alice" }],
            // no location → top-level comment
          },
          {
            comments: [
              {
                content: "fix this line",
                authorArn: "arn:aws:iam::1:user/alice",
              },
            ],
            location: { filePath: "src/foo.ts", filePosition: 10 },
          },
        ],
      });

      const reviews = await platform.getReviews(ri, 42);
      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("COMMENTED");
      expect(reviews[0].body).toBe("looks good");
    });
  });

  describe("getInlineComments", () => {
    it("returns only comments with a location", async () => {
      ccMock.on(GetCommentsForPullRequestCommand).resolves({
        commentsForPullRequestData: [
          {
            comments: [{ content: "top-level", authorArn: "arn:aws:iam::1:user/a" }],
          },
          {
            comments: [
              {
                content: "inline note",
                authorArn: "arn:aws:iam::1:user/a",
                creationDate: new Date("2024-01-01T00:00:00Z"),
              },
            ],
            location: { filePath: "src/foo.ts", filePosition: 10 },
          },
        ],
      });

      const comments = await platform.getInlineComments(ri, 42);
      expect(comments).toHaveLength(1);
      expect(comments[0].path).toBe("src/foo.ts");
      expect(comments[0].line).toBe(10);
      expect(comments[0].body).toBe("inline note");
    });
  });

  describe("mergePullRequest", () => {
    it("uses squash merge for 'squash'", async () => {
      ccMock.on(MergePullRequestBySquashCommand).resolves({});
      await platform.mergePullRequest(ri, 42, "squash");
      expect(ccMock.commandCalls(MergePullRequestBySquashCommand)).toHaveLength(1);
    });

    it("uses three-way merge for 'merge'", async () => {
      ccMock.on(MergePullRequestByThreeWayCommand).resolves({});
      await platform.mergePullRequest(ri, 42, "merge");
      expect(ccMock.commandCalls(MergePullRequestByThreeWayCommand)).toHaveLength(1);
    });
  });

  describe("submitReview", () => {
    it("posts approval and body comment for APPROVE", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          revisionId: "rev1",
          pullRequestTargets: [{ destinationCommit: "before", sourceCommit: "after" }],
        },
      });
      ccMock.on(UpdatePullRequestApprovalStateCommand).resolves({});
      ccMock.on(PostCommentForPullRequestCommand).resolves({});

      const res = await platform.submitReview(ri, 42, {
        event: "APPROVE",
        body: "LGTM",
      });

      expect(res.url).toBe(
        "https://us-east-1.console.aws.amazon.com/codesuite/codecommit/repositories/MyRepo/pull-requests/42",
      );
      expect(ccMock.commandCalls(UpdatePullRequestApprovalStateCommand)).toHaveLength(1);
      const calls = ccMock.commandCalls(PostCommentForPullRequestCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.content).toBe("LGTM");
    });

    it("prefixes body with [CHANGES REQUESTED] for REQUEST_CHANGES", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          revisionId: "rev1",
          pullRequestTargets: [{ destinationCommit: "before", sourceCommit: "after" }],
        },
      });
      ccMock.on(PostCommentForPullRequestCommand).resolves({});

      await platform.submitReview(ri, 42, {
        event: "REQUEST_CHANGES",
        body: "fix things",
      });

      const calls = ccMock.commandCalls(PostCommentForPullRequestCommand);
      expect(calls[0].args[0].input.content).toContain("[CHANGES REQUESTED]");
      expect(calls[0].args[0].input.content).toContain("fix things");
    });

    it("posts inline comments with location", async () => {
      ccMock.on(GetPullRequestCommand).resolves({
        pullRequest: {
          revisionId: "rev1",
          pullRequestTargets: [{ destinationCommit: "before", sourceCommit: "after" }],
        },
      });
      ccMock.on(PostCommentForPullRequestCommand).resolves({});

      await platform.submitReview(ri, 42, {
        event: "COMMENT",
        body: "",
        comments: [{ path: "src/foo.ts", line: 10, body: "nit" }],
      });

      const calls = ccMock.commandCalls(PostCommentForPullRequestCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input.location?.filePath).toBe("src/foo.ts");
      expect(calls[0].args[0].input.location?.filePosition).toBe(10);
    });
  });

  describe("listIssues / write methods", () => {
    it("listIssues returns empty", async () => {
      const issues = await platform.listIssues(ri);
      expect(issues).toEqual([]);
    });

    it("createLabel throws", async () => {
      await expect(platform.createLabel(ri, { name: "foo", color: "ff0000" })).rejects.toThrow(
        /labels/,
      );
    });

    it("createIssueComment throws", async () => {
      await expect(platform.createIssueComment(ri, 1, "hi")).rejects.toThrow(/issues/);
    });
  });

  describe("getRepoMetadata", () => {
    it("maps GetRepository to RepoMetadata", async () => {
      ccMock.on(GetRepositoryCommand).resolves({
        repositoryMetadata: {
          repositoryName: "MyRepo",
          defaultBranch: "develop",
        },
      });
      const md = await platform.getRepoMetadata(ri);
      expect(md.fullName).toBe("MyRepo");
      expect(md.defaultBranch).toBe("develop");
      expect(md.isPrivate).toBe(true);
    });
  });

  describe("listRepoContents", () => {
    it("maps files and subFolders to RepoContent", async () => {
      ccMock.on(GetRepositoryCommand).resolves({
        repositoryMetadata: { defaultBranch: "main" },
      });
      ccMock.on(GetFolderCommand).resolves({
        files: [{ absolutePath: "package.json", relativePath: "package.json" }],
        subFolders: [{ absolutePath: "src", relativePath: "src" }],
      });

      const contents = await platform.listRepoContents(ri);
      const types = Object.fromEntries(contents.map((c) => [c.name, c.type]));
      expect(types["package.json"]).toBe("file");
      expect(types["src"]).toBe("dir");
    });
  });
});
