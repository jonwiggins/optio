import { Command } from "commander";
import { performLogin } from "../auth/login.js";
import { green } from "../output/colors.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { friendlyError } from "../utils/errors.js";

export const loginCommand = new Command("login")
  .description("Authenticate with an Optio server")
  .option("--server <url>", "Server URL")
  .option("--provider <name>", "OAuth provider (github, google, gitlab)")
  .action(async (opts) => {
    try {
      const server = opts.server ?? process.env.OPTIO_SERVER;
      if (!server) {
        process.stderr.write(
          "Error: No server specified. Use --server <url> or set OPTIO_SERVER.\n",
        );
        process.exit(1);
      }

      const result = await performLogin(server, opts.provider);

      if (isJsonMode()) {
        outputJson({ host: result.host, user: result.user });
      } else {
        process.stdout.write(green(`Logged in as ${result.user.email} on ${result.host}`) + "\n");
      }
    } catch (err) {
      friendlyError(err);
    }
  });
