import { red, yellow } from "../output/colors.js";
import { isJsonMode } from "../output/formatter.js";
import { ApiError, NetworkError, EXIT_FAILURE, EXIT_AUTH, EXIT_NETWORK } from "../api/errors.js";

export function friendlyError(err: unknown): never {
  if (err instanceof ApiError) {
    const msg = (err.body.error as string) || `HTTP ${err.statusCode}`;
    if (isJsonMode()) {
      process.stderr.write(JSON.stringify({ error: msg, statusCode: err.statusCode }) + "\n");
    } else {
      process.stderr.write(red(`Error: ${msg}`) + "\n");
      if (err.statusCode === 401) {
        process.stderr.write(yellow("Tip: Run `optio login` to reauthenticate.") + "\n");
      } else if (err.statusCode === 403) {
        process.stderr.write(
          yellow("Tip: Ask a workspace admin to grant you the required role.") + "\n",
        );
      } else if (err.statusCode >= 500) {
        process.stderr.write(
          yellow("Tip: File an issue at https://github.com/jonwiggins/optio/issues") + "\n",
        );
      }
    }
    process.exit(err.exitCode);
  }

  if (err instanceof NetworkError) {
    if (isJsonMode()) {
      process.stderr.write(JSON.stringify({ error: err.message }) + "\n");
    } else {
      process.stderr.write(red(`Error: ${err.message}`) + "\n");
      process.stderr.write(
        yellow("Tip: Run `optio whoami` to verify your configured server.") + "\n",
      );
    }
    process.exit(EXIT_NETWORK);
  }

  // Unknown error
  const msg = err instanceof Error ? err.message : String(err);
  if (isJsonMode()) {
    process.stderr.write(JSON.stringify({ error: msg }) + "\n");
  } else {
    process.stderr.write(red(`Error: ${msg}`) + "\n");
  }
  process.exit(EXIT_FAILURE);
}
