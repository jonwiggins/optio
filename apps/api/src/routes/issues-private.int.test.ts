/**
 * The issue list marks issues Optio is already working on. Another member's
 * private task is theirs and the admins' to see, so it must not show (with
 * its id and state) on the issue for everyone else.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { buildRouteTestApp } from "../test-utils/build-route-test-app.js";
import { insertRepo, insertTask, insertWorkspace } from "../test-utils/integration/fixtures.js";

vi.mock("../services/git-token-service.js", () => ({
  getGitPlatformForRepo: async () => ({
    platform: {
      listIssues: async () => [
        {
          id: 5,
          number: 5,
          title: "Bug",
          body: "",
          state: "open",
          url: "https://github.com/it-org/issues/issues/5",
          labels: [],
          author: "alice",
          assignee: null,
          isPullRequest: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    },
  }),
}));

const { issueRoutes } = await import("./issues.js");

async function insertUser(displayName: string) {
  const [row] = await db
    .insert(users)
    .values({
      provider: "github",
      externalId: `it-${randomBytes(4).toString("hex")}`,
      email: `${randomBytes(4).toString("hex")}@issues.it`,
      displayName,
    })
    .returning();
  return row.id;
}

describe("issue list and private tasks (integration)", () => {
  it("links an issue to a private task only for its owner and admins", async () => {
    const ws = (await insertWorkspace()).id;
    const owner = await insertUser("Owner");
    const other = await insertUser("Other");
    const repo = await insertRepo({ workspaceId: ws });
    const task = await insertTask({
      workspaceId: ws,
      ownerUserId: owner,
      repoUrl: repo.repoUrl,
      ticketSource: "github",
      ticketExternalId: "5",
    });
    const linkFor = async (id: string, workspaceRole: "admin" | "member") => {
      const app = await buildRouteTestApp(issueRoutes, {
        user: { id, workspaceId: ws, workspaceRole },
      });
      const res = await app.inject({ url: "/api/issues" });
      expect(res.statusCode).toBe(200);
      const [issue] = res.json().issues;
      return issue.optioTask?.taskId ?? null;
    };
    expect(await linkFor(other, "member")).toBeNull();
    expect(await linkFor(owner, "member")).toBe(task.id);
    expect(await linkFor(other, "admin")).toBe(task.id);
  });
});
