import { Command } from "commander";
import { getCurrentUser } from "../auth/current-user.js";
import { bold, dim } from "../output/colors.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { friendlyError } from "../utils/errors.js";

export const whoamiCommand = new Command("whoami")
  .description("Show current user and server")
  .action(async (_opts, cmd) => {
    try {
      const globals = cmd.optsWithGlobals();
      const result = await getCurrentUser(globals);
      if (isJsonMode()) {
        outputJson(result);
      } else {
        process.stdout.write(bold(result.user.displayName) + "\n");
        process.stdout.write(dim(`  Email:  `) + result.user.email + "\n");
        process.stdout.write(dim(`  Server: `) + result.server + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
