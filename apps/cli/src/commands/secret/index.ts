import { Command } from "commander";
import { secretListCommand } from "./list.js";
import { secretSetCommand } from "./set.js";
import { secretRmCommand } from "./rm.js";

export const secretCommand = new Command("secret")
  .description("Manage secrets")
  .addCommand(secretListCommand)
  .addCommand(secretSetCommand)
  .addCommand(secretRmCommand);
