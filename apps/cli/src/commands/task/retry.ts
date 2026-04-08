import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const taskRetryCommand = new Command("retry")
  .description("Retry a failed task")
  .argument("<id>", "Task ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.post<{ task: Record<string, unknown> }>(`/api/tasks/${id}/retry`);

      if (isJsonMode()) {
        outputJson(data);
      } else {
        process.stdout.write(
          green(`Task ${id} retried → ${(data.task?.state as string) ?? "queued"}`) + "\n",
        );
      }
    } catch (err) {
      friendlyError(err);
    }
  });
