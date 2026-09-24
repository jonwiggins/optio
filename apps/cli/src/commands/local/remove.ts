import { Command } from "commander";
import { red, green } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { DirAllowlistError, removeAllowedDir } from "../../local/dir-allowlist.js";
import { friendlyError } from "../../utils/errors.js";

export const localRemoveCommand = new Command("remove")
  .description("Remove a directory from the Optio Local allowlist")
  .argument("<dir>", "Directory to remove")
  .action(async (dir: string, _opts, cmd) => {
    try {
      void cmd;
      let removed;
      try {
        removed = removeAllowedDir(dir);
      } catch (err) {
        if (!(err instanceof DirAllowlistError)) throw err;
        process.stderr.write(red(`Error: ${err.message}`) + "\n");
        process.exit(1);
      }

      if (isJsonMode()) {
        outputJson({ path: removed.path, removed: true });
        return;
      }
      process.stdout.write(green(`Removed ${removed.path}`) + "\n");
    } catch (err) {
      friendlyError(err);
    }
  });
