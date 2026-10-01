import { readFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

/**
 * The AWS profile names on this machine (`[default]`, `[profile x]` in
 * ~/.aws/config, `[x]` in ~/.aws/credentials, or the files AWS_CONFIG_FILE /
 * AWS_SHARED_CREDENTIALS_FILE name). Names only — never a key — so Optio can
 * tell whether a model provider's profile is here before it runs an agent.
 */
export function listAwsProfiles(env: NodeJS.ProcessEnv = process.env): string[] {
  const home = env.HOME || os.homedir();
  const configPath = env.AWS_CONFIG_FILE || join(home, ".aws", "config");
  const credentialsPath = env.AWS_SHARED_CREDENTIALS_FILE || join(home, ".aws", "credentials");
  const names = new Set<string>();
  for (const name of sectionNames(configPath)) {
    if (name === "default") names.add("default");
    else if (name.startsWith("profile ")) names.add(name.slice("profile ".length).trim());
  }
  for (const name of sectionNames(credentialsPath)) names.add(name);
  return [...names].filter((n) => /^[A-Za-z0-9._+=@-]{1,64}$/.test(n)).sort();
}

function sectionNames(path: string): string[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}
