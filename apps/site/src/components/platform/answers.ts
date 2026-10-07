/** The five attributes in the Work editor. Environment belongs under Where. */
export const ANSWERS = [
  {
    key: "when",
    name: "When",
    color: "#a78bfa",
    detail: "now · schedule · webhook · event",
    text: "Start now, set a schedule, or respond to tickets, webhooks, and events from GitHub, Slack, Linear, Pylon, or PagerDuty.",
  },
  {
    key: "where",
    name: "Where",
    color: "#60a5fa",
    detail: "pod · repo · your machine",
    text: "Use an Optio pod with a repository or without one, or work in a directory on a paired machine. Configure the pod’s environment here, too.",
  },
  {
    key: "who",
    name: "Who",
    color: "#f0a040",
    detail: "your agent runtime · a terminal",
    text: "Choose Claude Code, Codex, Copilot, Gemini, Cursor, OpenCode, or OpenClaw where supported. Use a terminal for shell commands and interactive work.",
  },
  {
    key: "what",
    name: "What",
    color: "#818cf8",
    detail: "prompt · template · command",
    text: "Write the instructions, reuse a prompt template, or supply a shell command. Trigger parameters can fill in the details for each run.",
  },
  {
    key: "then",
    name: "Then",
    color: "#34d399",
    detail: "exits · waits for you · persists",
    text: "Exit when done, wait for your next turn, or keep a persistent agent available for messages. Repo work can open a PR and follow it through review and merge.",
  },
] as const;

export type AnswerKey = (typeof ANSWERS)[number]["key"];
