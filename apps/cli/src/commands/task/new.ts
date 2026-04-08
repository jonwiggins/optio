import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green, dim } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const taskNewCommand = new Command("new")
  .description("Create a new task")
  .argument("<repo>", "Repository URL")
  .argument("<prompt>", "Task prompt/description")
  .option("--title <title>", "Task title")
  .option("--branch <branch>", "Target branch")
  .option("--agent <agent>", "Agent type (claude-code, codex, copilot)")
  .option("--model <model>", "Model name")
  .option("--priority <n>", "Priority (lower = higher)", parseInt)
  .option("--max-retries <n>", "Max retries", parseInt)
  .option("--depends-on <id>", "Task ID this depends on")
  .option("--wait", "Wait for task to complete")
  .option("--metadata <kv...>", "Key=value metadata pairs")
  .action(async (repo, prompt, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);

      const body: Record<string, unknown> = {
        repoUrl: repo,
        prompt,
      };
      if (opts.title) body.title = opts.title;
      if (opts.branch) body.repoBranch = opts.branch;
      if (opts.agent) body.agentType = opts.agent;
      if (opts.model) body.claudeModel = opts.model;
      if (opts.priority !== undefined) body.priority = opts.priority;
      if (opts.maxRetries !== undefined) body.maxRetries = opts.maxRetries;
      if (opts.dependsOn) body.dependsOnTaskId = opts.dependsOn;
      if (opts.metadata) {
        const md: Record<string, string> = {};
        for (const kv of opts.metadata) {
          const [k, ...rest] = kv.split("=");
          md[k] = rest.join("=");
        }
        body.metadata = md;
      }

      const task = await client.post<{ task: Record<string, unknown> }>("/api/tasks", body);

      if (opts.wait) {
        // Poll until terminal state
        const taskId = task.task.id as string;
        process.stderr.write(`Waiting for task ${taskId}...\n`);
        let current = task.task;
        while (
          !["completed", "pr_opened", "failed", "cancelled"].includes(current.state as string)
        ) {
          await new Promise((r) => setTimeout(r, 5000));
          const result = await client.get<{ task: Record<string, unknown> }>(
            `/api/tasks/${taskId}`,
          );
          current = result.task;
        }
        if (isJsonMode()) {
          outputJson(current);
        } else {
          const state = current.state as string;
          process.stdout.write(`Task ${taskId} → ${state}\n`);
          if (current.prUrl) process.stdout.write(`PR: ${current.prUrl}\n`);
        }
        const terminalState = current.state as string;
        if (terminalState === "failed" || terminalState === "cancelled") {
          process.exit(1);
        }
        return;
      }

      if (isJsonMode()) {
        outputJson(task);
      } else {
        const t = task.task;
        process.stdout.write(green(`Created task ${t.id}`) + "\n");
        if (t.prUrl) process.stdout.write(dim(`PR: ${t.prUrl}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
