import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const repoRemoveCommand = new Command("remove")
  .description("Remove a repository")
  .argument("<id>", "Repo ID")
  .action(async (id, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      await client.delete(`/api/repos/${id}`);

      if (isJsonMode()) {
        outputJson({ ok: true });
      } else {
        process.stdout.write(green(`Removed repo ${id}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
