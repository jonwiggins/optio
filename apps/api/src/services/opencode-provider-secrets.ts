import { OPENCODE_PROVIDER_KEYS } from "@optio/agent-adapters";

/** OpenCode takes every stored provider key; it needs at least one unless a custom base URL serves it. */
export async function opencodeProviderSecrets(
  secret: (name: string) => Promise<string | null>,
  baseUrl: unknown,
): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of OPENCODE_PROVIDER_KEYS) {
    const value = await secret(name);
    if (value) found[name] = value;
  }
  if (Object.keys(found).length === 0 && !(typeof baseUrl === "string" && baseUrl)) {
    const keys = [...OPENCODE_PROVIDER_KEYS];
    throw new Error(
      `OpenCode needs one of ${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1]} as a secret, or a custom base URL (opencodeBaseUrl)`,
    );
  }
  return found;
}
