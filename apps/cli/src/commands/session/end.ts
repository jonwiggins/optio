import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const sessionEndCommand = new Command("end")
  .description("End an interactive session")
  .argument("<id>", "Session ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      await client.post(`/api/sessions/${id}/end`);

      if (isJsonMode()) {
        outputJson({ ok: true });
      } else {
        process.stdout.write(green(`Session ${id} ended`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
