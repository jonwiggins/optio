import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const secretRmCommand = new Command("rm")
  .description("Remove a secret")
  .argument("<name>", "Secret name")
  .action(async (name, _opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);
      await client.delete(`/api/secrets/${encodeURIComponent(name)}`);

      if (isJsonMode()) {
        outputJson({ ok: true });
      } else {
        process.stdout.write(green(`Secret ${name} removed`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
