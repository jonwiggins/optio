import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { bold, dim, green, yellow, red } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

const STATE_COLOR: Record<string, (s: string) => string> = {
  completed: green,
  pr_opened: green,
  running: yellow,
  queued: yellow,
  failed: red,
  cancelled: red,
};

export const taskShowCommand = new Command("show")
  .description("Show task details")
  .argument("<id>", "Task ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.get<{ task: Record<string, string> }>(`/api/tasks/${id}`);

      if (isJsonMode()) {
        outputJson(data.task);
        return;
      }

      const t = data.task;
      const colorFn = STATE_COLOR[t.state] ?? dim;
      process.stdout.write(bold(t.title ?? "Untitled") + "\n");
      process.stdout.write(dim("  ID:     ") + t.id + "\n");
      process.stdout.write(dim("  State:  ") + colorFn(t.state) + "\n");
      process.stdout.write(dim("  Repo:   ") + t.repoUrl + "\n");
      if (t.repoBranch) process.stdout.write(dim("  Branch: ") + t.repoBranch + "\n");
      if (t.agentType) process.stdout.write(dim("  Agent:  ") + t.agentType + "\n");
      if (t.prUrl) process.stdout.write(dim("  PR:     ") + t.prUrl + "\n");
      if (t.costUsd) process.stdout.write(dim("  Cost:   ") + `$${t.costUsd}` + "\n");
      if (t.errorMessage) process.stdout.write(red("  Error:  ") + t.errorMessage + "\n");
    } catch (err) {
      friendlyError(err);
    }
  });
