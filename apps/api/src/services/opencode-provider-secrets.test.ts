import { expect, it } from "vitest";
import { opencodeProviderSecrets } from "./opencode-provider-secrets.js";

const stored = (values: Record<string, string>) => async (name: string) => values[name] ?? null;

it("signs in with an OpenCode Zen / Go key alone", async () => {
  expect(await opencodeProviderSecrets(stored({ OPENCODE_API_KEY: "zen" }), undefined)).toEqual({
    OPENCODE_API_KEY: "zen",
  });
});
it("still signs in with Anthropic and OpenAI keys and no others", async () => {
  expect(
    await opencodeProviderSecrets(
      stored({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" }),
      undefined,
    ),
  ).toEqual({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
});
it("needs no key with a custom base URL", async () => {
  expect(await opencodeProviderSecrets(stored({}), "http://llm.internal/v1")).toEqual({});
});
it("names every accepted key when none is stored", async () => {
  await expect(opencodeProviderSecrets(stored({}), undefined)).rejects.toThrow(
    /ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY or OPENCODE_API_KEY/,
  );
});
