import { Command } from "commander";
import { performLogin } from "../auth/login.js";
import { green } from "../output/colors.js";
import { isJsonMode, outputJson } from "../output/formatter.js";
import { friendlyError } from "../utils/errors.js";

export const loginCommand = new Command("login")
  .description("Authenticate with an Optio server")
  .option("--server <url>", "Server URL")
  .option(
    "--provider <name>",
    "Sign-in provider (bitbucket, gitea, github, gitlab, google, ldap, oidc, saml)",
  )
  .option("--list-providers", "List enabled sign-in providers and exit")
  .action(async (opts) => {
    try {
      const server = opts.server ?? process.env.OPTIO_SERVER;
      if (!server) {
        process.stderr.write(
          "Error: No server specified. Use --server <url> or set OPTIO_SERVER.\n",
        );
        process.exit(1);
      }

      if (opts.listProviders) {
        const response = await fetch(`${server.replace(/\/+$/, "")}/api/auth/providers`);
        if (!response.ok) throw new Error(`Provider discovery failed: ${response.status}`);
        const data = (await response.json()) as {
          providers: Array<{ name: string; displayName: string }>;
        };
        if (isJsonMode()) outputJson(data);
        else for (const p of data.providers) process.stdout.write(`${p.name}\t${p.displayName}\n`);
        return;
      }
      const result = await performLogin(server, opts.provider);

      if (isJsonMode()) {
        outputJson({ host: result.host, user: result.user });
      } else {
        process.stdout.write(
          green(
            `Logged in as ${result.user.email || result.user.displayName || result.user.id} on ${result.host}`,
          ) + "\n",
        );
      }
    } catch (err) {
      friendlyError(err);
    }
  });
