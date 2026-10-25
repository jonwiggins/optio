import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../auth/login.js", () => ({ performLogin: vi.fn() }));
vi.mock("../utils/errors.js", () => ({ friendlyError: vi.fn() }));
vi.mock("../output/formatter.js", () => ({ isJsonMode: () => false, outputJson: vi.fn() }));
import { loginCommand } from "../commands/login.js";

afterEach(() => vi.restoreAllMocks());
describe("optio login --list-providers", () => {
  it("lists every enabled provider without starting a login", async () => {
    const providers = [
      "bitbucket",
      "gitea",
      "github",
      "gitlab",
      "google",
      "ldap",
      "oidc",
      "saml",
    ].map((name) => ({ name, displayName: name }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ providers })));
    const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await loginCommand.parseAsync(["--server", "https://optio.example.test", "--list-providers"], {
      from: "user",
    });
    for (const p of providers) expect(output).toHaveBeenCalledWith(`${p.name}\t${p.displayName}\n`);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});
