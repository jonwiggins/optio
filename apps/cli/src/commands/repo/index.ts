import { Command } from "commander";
import { repoListCommand } from "./list.js";
import { repoShowCommand } from "./show.js";
import { repoAddCommand } from "./add.js";
import { repoRemoveCommand } from "./remove.js";

export const repoCommand = new Command("repo")
  .description("Manage repositories")
  .addCommand(repoListCommand)
  .addCommand(repoShowCommand)
  .addCommand(repoAddCommand)
  .addCommand(repoRemoveCommand);
