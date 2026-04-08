import { createProgram } from "./program.js";

const program = createProgram();
program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
