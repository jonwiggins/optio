/**
 * Notification webhooks against real Postgres: an event of one workspace's
 * work reaches that workspace's webhooks, and the deployment's (no
 * workspace) only for the founding workspace — never another workspace's.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { insertWorkspace } from "../test-utils/integration/fixtures.js";
import { createWebhook, getWebhooksForEvent } from "./webhook-service.js";

let founding: string;
let teamA: string;
let teamB: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  founding = (await insertWorkspace({ name: "founding", createdAt: new Date(2020, 0, 1) })).id;
  teamA = (await insertWorkspace({ name: "team a" })).id;
  teamB = (await insertWorkspace({ name: "team b" })).id;
  const hook = async (name: string, workspaceId: string | null) => {
    ids[name] = (
      await createWebhook(
        { url: `https://hooks.example.test/${name}`, events: ["task.completed"] },
        undefined,
        workspaceId,
      )
    ).id;
  };
  await hook("deployment", null);
  await hook("founding", founding);
  await hook("a", teamA);
  await hook("b", teamB);
});

const names = async (workspaceId: string | null) => {
  const hooks = await getWebhooksForEvent("task.completed", workspaceId);
  return hooks.map((h) => Object.entries(ids).find(([, id]) => id === h.id)![0]).sort();
};

describe("notification webhooks by workspace", () => {
  it("a workspace's event reaches its own webhooks only", async () => {
    expect(await names(teamA)).toEqual(["a"]);
    expect(await names(teamB)).toEqual(["b"]);
  });

  it("the founding workspace's events also reach the deployment's webhooks", async () => {
    expect(await names(founding)).toEqual(["deployment", "founding"]);
  });

  it("an event with no workspace reaches the deployment's webhooks only", async () => {
    expect(await names(null)).toEqual(["deployment"]);
  });

  it("ignores webhooks not subscribed to the event", async () => {
    expect(await getWebhooksForEvent("task.failed", teamA)).toEqual([]);
  });
});
