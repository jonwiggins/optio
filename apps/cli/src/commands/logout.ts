import { Command } from "commander";
import { performLogout } from "../auth/logout.js";
import { green } from "../output/colors.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { friendlyError } from "../utils/errors.js";

export const logoutCommand = new Command("logout")
  .description("Log out from an Optio server")
  .option("--server <url>", "Server URL to log out from")
  .action(async (opts) => {
    try {
      const result = await performLogout(opts.server);
      if (isJsonMode()) {
        outputJson({ ok: true, host: result.host });
      } else {
        process.stdout.write(green(`Logged out from ${result.host}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
