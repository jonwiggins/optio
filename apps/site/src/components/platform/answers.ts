/**
 * The article's five answers — one list for the prose, the composer, and the
 * diagram. The product's own five are When / Where / Who / What / Then, with
 * Environment under Where; the article gives Environment a column of its own
 * and treats the prompt (What) as the work itself.
 */

export const ANSWERS = [
  {
    key: "when",
    name: "When",
    color: "#a78bfa",
    detail: "now · cron · webhook · ticket · event",
    text: "now, a cron, a webhook, a ticket, a GitHub, Slack, or Linear event, or a message from a person or another agent.",
  },
  {
    key: "where",
    name: "Where",
    color: "#60a5fa",
    detail: "pod · repo · your machine",
    text: "an isolated pod, with one of your repos or none, or a directory on your own machine.",
  },
  {
    key: "who",
    name: "Who",
    color: "#f0a040",
    detail: "7 agent runtimes · a shell",
    text: "Claude Code, Codex, Copilot, Gemini, Cursor, OpenCode, OpenClaw, or a plain shell command.",
  },
  {
    key: "env",
    name: "Environment",
    color: "#818cf8",
    detail: "MCP · connections · skills · secrets",
    text: "connections, MCP servers, and skills default to the repo's and the workspace's; each piece of work adds or removes them, picks its pod's secrets, and can add setup commands.",
  },
  {
    key: "then",
    name: "Then",
    color: "#34d399",
    detail: "exits · until merged · waits · persists",
    text: "exit when done, work the PR until it merges, wait for you, or stay on as an agent with memory.",
  },
] as const;

export type AnswerKey = (typeof ANSWERS)[number]["key"];
