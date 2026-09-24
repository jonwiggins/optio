import { Command } from "commander";
import { red, green, dim } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { DirAllowlistError, addAllowedDir } from "../../local/dir-allowlist.js";
import { friendlyError } from "../../utils/errors.js";

export const localAddCommand = new Command("add")
  .description("Add a directory to the Optio Local allowlist")
  .argument("<dir>", "Directory to expose to the daemon")
  .action(async (dir: string, _opts, cmd) => {
    try {
      void cmd;
      let added;
      try {
        added = await addAllowedDir(dir);
      } catch (err) {
        if (!(err instanceof DirAllowlistError)) throw err;
        process.stderr.write(red(`Error: ${err.message}`) + "\n");
        process.exit(1);
      }
      const { path, repoUrl, alreadyAdded } = added;

      if (isJsonMode()) {
        outputJson({ path, repoUrl: repoUrl ?? null, alreadyAdded: Boolean(alreadyAdded) });
        return;
      }
      const suffix = repoUrl ? ` ${dim(`(${repoUrl})`)}` : "";
      process.stdout.write(
        green(alreadyAdded ? `Updated ${path}` : `Added ${path}`) + suffix + "\n",
      );
      if (!alreadyAdded) {
        process.stdout.write(
          dim("Restart `optio local up` (or wait for its next reconnect) to advertise it.") + "\n",
        );
      }
    } catch (err) {
      friendlyError(err);
    }
  });
