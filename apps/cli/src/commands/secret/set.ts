import { Command } from "commander";
import { buildClient } from "../../api/client.js";
import { green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { friendlyError } from "../../utils/errors.js";

export const secretSetCommand = new Command("set")
  .description("Set a secret value")
  .argument("<name>", "Secret name")
  .argument("[value]", "Secret value (or reads from stdin)")
  .option("--scope <scope>", "Secret scope", "global")
  .action(async (name, value, opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const client = buildClient(globals);

      // If no value provided, read from stdin
      if (!value) {
        if (process.stdin.isTTY) {
          process.stderr.write("Enter secret value: ");
        }
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        value = Buffer.concat(chunks).toString().trim();
      }

      await client.post("/api/secrets", {
        name,
        value,
        scope: opts.scope,
      });

      if (isJsonMode()) {
        outputJson({ ok: true, name });
      } else {
        process.stdout.write(green(`Secret ${name} set`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
