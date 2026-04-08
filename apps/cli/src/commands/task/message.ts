import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const taskMessageCommand = new Command("message")
  .description("Send a message to a running task")
  .argument("<id>", "Task ID")
  .argument("<message>", "Message content")
  .option("--interrupt", "Interrupt the current agent turn")
  .action(async (id, message, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      const data = await client.post<Record<string, unknown>>(`/api/tasks/${id}/messages`, {
        content: message,
        mode: opts.interrupt ? "interrupt" : "soft",
      });

      if (isJsonMode()) {
        outputJson(data);
      } else {
        process.stdout.write(green(`Message sent to task ${id}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
