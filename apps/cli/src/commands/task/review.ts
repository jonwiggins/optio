import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const taskReviewCommand = new Command("review")
  .description("Trigger a review for a task")
  .argument("<id>", "Task ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.post<Record<string, unknown>>(`/api/tasks/${id}/review`);

      if (isJsonMode()) {
        outputJson(data);
      } else {
        process.stdout.write(green(`Review triggered for task ${id}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
