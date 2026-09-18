import { Command } from "commander";
import { dim } from "../../output/colors.js";
import { isJsonMode, outputJson } from "../../output/formatter.js";
import { printTable } from "../../output/table.js";
import { loadLocalConfig } from "../../config/local-store.js";
import { friendlyError } from "../../utils/errors.js";

export const localDirsCommand = new Command("dirs")
  .description("List the Optio Local directory allowlist")
  .action(async (_opts, cmd) => {
    try {
      void cmd;
      const config = loadLocalConfig();

      if (isJsonMode()) {
        outputJson(config.dirs);
        return;
      }
      if (config.dirs.length === 0) {
        process.stdout.write(
          dim("No directories in the allowlist. Add one with `optio local add <dir>`.") + "\n",
        );
        return;
      }
      printTable(
        [
          { header: "PATH", key: "path" },
          { header: "REPO", key: "repoUrl" },
        ],
        config.dirs.map((d) => ({ path: d.path, repoUrl: d.repoUrl ?? "" })),
      );
    } catch (err) {
      friendlyError(err);
    }
  });
