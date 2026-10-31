import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isWebhookFormat,
  mattermostBody,
  renderWebhookBody,
  summarize,
  teamsBody,
} from "./chat-formats.js";

const BASE = "https://optio.example.com";

const taskData = {
  taskId: "t-1",
  taskTitle: "Add a [health] endpoint",
  repoUrl: "https://gitlab.example.com/platform/hello-service",
  repoBranch: "main",
  fromState: "running",
  toState: "pr_opened",
  prUrl: "https://gitlab.example.com/platform/hello-service/-/merge_requests/7",
};

const runData = {
  runId: "r-1",
  workflowId: "j-1",
  workflowName: "Nightly report",
  state: "failed",
  costUsd: "0.1234",
  durationMs: 4200,
  modelUsed: "qwen-internal",
  errorMessage: "exit status 3",
};

const slack = vi.fn((event: string) => ({ text: `slack ${event}`, blocks: [] }));

beforeEach(() => {
  vi.stubEnv("PUBLIC_URL", BASE);
  slack.mockClear();
});
afterEach(() => vi.unstubAllEnvs());

describe("renderWebhookBody", () => {
  it("keeps upstream's rule when the webhook has no format", () => {
    expect(renderWebhookBody(null, "task.completed", taskData, slack)).toBeNull();
    expect(renderWebhookBody(undefined, "task.completed", taskData, slack)).toBeNull();
    expect(renderWebhookBody("irc", "task.completed", taskData, slack)).toBeNull();
  });

  it("sends Optio's JSON for generic, whatever the URL", () => {
    const body = renderWebhookBody("generic", "task.pr_opened", taskData, slack);
    expect(body).toEqual({
      event: "task.pr_opened",
      timestamp: expect.any(String),
      data: taskData,
    });
    expect(slack).not.toHaveBeenCalled();
  });

  it("uses upstream's Slack builder for slack, whatever the URL", () => {
    expect(renderWebhookBody("slack", "task.failed", taskData, slack)).toEqual({
      text: "slack task.failed",
      blocks: [],
    });
  });

  it("gives Mattermost a Markdown text with the work linked", () => {
    const body = renderWebhookBody("mattermost", "task.pr_opened", taskData, slack) as {
      text: string;
    };
    expect(Object.keys(body)).toEqual(["text"]);
    expect(body.text).toContain("#### :rocket: Merge request opened");
    expect(body.text).toContain(`**[Add a \\[health\\] endpoint](${BASE}/work/t-1)**`);
    expect(body.text).toContain("Repository: platform/hello-service · Branch: main");
    expect(body.text).toContain(`Merge request: ${taskData.prUrl}`);
  });

  it("gives Teams a message with an Adaptive Card", () => {
    const body = renderWebhookBody("msteams", "workflow_run.failed", runData, slack) as any;
    expect(body.type).toBe("message");
    expect(body.attachments).toHaveLength(1);
    const card = body.attachments[0];
    expect(card.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(card.content.type).toBe("AdaptiveCard");
    expect(card.content.version).toBe("1.4");
    expect(card.content.body[0]).toMatchObject({ text: "Job run failed", color: "Attention" });
    expect(card.content.body[1].text).toBe("Nightly report");
    expect(card.content.body[2].facts).toEqual([
      { title: "Model", value: "qwen-internal" },
      { title: "Cost", value: "$0.12" },
      { title: "Duration", value: "4s" },
    ]);
    expect(card.content.body[3]).toMatchObject({ text: "exit status 3", fontType: "Monospace" });
    expect(card.content.actions).toEqual([
      { type: "Action.OpenUrl", title: "Open in Optio", url: `${BASE}/jobs/j-1/runs/r-1` },
    ]);
  });
});

describe("summarize", () => {
  it("leaves the link out without PUBLIC_URL", () => {
    expect(summarize("task.failed", taskData, null).link).toBeNull();
  });

  it("names an unknown event by itself", () => {
    expect(summarize("something.new", {}, BASE)).toMatchObject({
      headline: "something.new",
      name: "Task",
    });
  });

  it("clips a long error", () => {
    const s = summarize("task.failed", { ...taskData, errorMessage: "e".repeat(2000) }, BASE);
    expect(s.error!.length).toBe(500);
  });
});

describe("formats", () => {
  it("knows the four formats", () => {
    expect(["generic", "slack", "mattermost", "msteams"].every(isWebhookFormat)).toBe(true);
    expect(isWebhookFormat("teams")).toBe(false);
  });

  it("keeps a code fence in an error from breaking the Mattermost message", () => {
    const body = mattermostBody("task.failed", { ...taskData, errorMessage: "a ``` b" }, BASE);
    expect((body.text as string).match(/```/g)).toHaveLength(2);
  });

  it("shows a hostile title, branch and error in Mattermost as text: no links, markup or pings", () => {
    const hostile = {
      ...taskData,
      taskTitle: "Fix [login](https://evil.example) @channel **now**\n# Heading @all",
      repoBranch: "feat/`x`_y @here ~town-square",
      errorMessage: "boom @all",
    };
    const text = mattermostBody("task.failed", hostile, BASE).text as string;
    const lines = text.split("\n");
    // The only link is Optio's own; the title's is shown as written.
    expect(lines[1]).toBe(
      "**[Fix \\[login\\]\\(https://evil.example\\) @\u200Bchannel \\*\\*now\\*\\* " +
        `\\# Heading @\u200Ball](${BASE}/work/t-1)**`,
    );
    expect(lines[2]).toBe(
      "Repository: platform/hello-service · Branch: feat/\\`x\\`\\_y @\u200Bhere \\~town-square · " +
        `Merge request: ${taskData.prUrl}`,
    );
    expect(lines.slice(3)).toEqual(["```", "boom @\u200Ball", "```"]);
    expect(text).not.toMatch(/@(channel|all|here)/);
    expect(text).not.toMatch(/\]\(https:\/\/evil/);
  });

  it("shows a merge request address with markup in it as text in Mattermost", () => {
    const text = mattermostBody(
      "task.pr_opened",
      { ...taskData, prUrl: "https://x.example/[a](https://evil.example)" },
      BASE,
    ).text as string;
    expect(text).toContain("Merge request: https://x.example/\\[a\\]\\(https://evil.example\\)");
  });

  it("keeps a Teams card's text from turning into links", () => {
    const body = teamsBody(
      "task.failed",
      {
        ...taskData,
        taskTitle: "See [this](https://evil.example)",
        repoBranch: "[b](https://evil.example)",
        errorMessage: "[e] (https://evil.example)",
      },
      BASE,
    ) as any;
    const card = body.attachments[0].content;
    expect(card.body[1].text).toBe("See [this]\u200B(https://evil.example)");
    expect(card.body[2].facts[1]).toEqual({
      title: "Branch",
      value: "[b]\u200B(https://evil.example)",
    });
    expect(card.body[3].text).toBe("[e]\u200B(https://evil.example)");
  });

  it("adds a merge request button for a task in Teams", () => {
    const body = teamsBody("task.pr_opened", taskData, BASE) as any;
    expect(body.attachments[0].content.actions.map((a: any) => a.title)).toEqual([
      "Open in Optio",
      "Open the merge request",
    ]);
  });
});
