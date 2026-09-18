import { Command } from "commander";
import { localUpCommand } from "./up.js";
import { localAddCommand } from "./add.js";
import { localRemoveCommand } from "./remove.js";
import { localDirsCommand } from "./dirs.js";
import { localStatusCommand } from "./status.js";

export const localCommand = new Command("local")
  .description("Run terminals on this machine from the Optio UI")
  .addCommand(localUpCommand)
  .addCommand(localAddCommand)
  .addCommand(localRemoveCommand)
  .addCommand(localDirsCommand)
  .addCommand(localStatusCommand);
