import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deleteModelProviderAsking } from "./gateway-keys-api";

// Deleting a gateway whose Optio-made keys LiteLLM can't delete: the API's
// 409 says why, and the admin is asked whether to delete it anyway.

const fetchMock = vi.fn();

function answer(status: number, body: unknown = {}) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("localStorage", { getItem: vi.fn().mockReturnValue(null), setItem: vi.fn() });
});

afterEach(() => vi.unstubAllGlobals());

const gateway = { id: "g1", name: "LiteLLM" };
const refusal =
  "Optio couldn't delete the 2 keys it made on LiteLLM in LiteLLM (database is down). Fix that and delete it again, or delete it anyway: those keys then stay in LiteLLM until someone deletes them there.";

describe("deleteModelProviderAsking", () => {
  it("deletes without asking when LiteLLM took the keys", async () => {
    answer(204);
    const ask = vi.fn();
    expect(await deleteModelProviderAsking(gateway, ask)).toBe(true);
    expect(ask).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/model-providers/g1");
  });

  it("asks on a 409 with the reason, and deletes anyway only on yes", async () => {
    answer(409, { error: refusal });
    const no = vi.fn().mockReturnValue(false);
    expect(await deleteModelProviderAsking(gateway, no)).toBe(false);
    expect(no).toHaveBeenCalledWith(`${refusal}\n\nDelete LiteLLM anyway?`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    answer(409, { error: refusal });
    answer(204);
    expect(await deleteModelProviderAsking(gateway, () => true)).toBe(true);
    expect(fetchMock.mock.calls[2][0]).toBe("/api/model-providers/g1?force=true");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
  });

  it("any other refusal is the caller's to show", async () => {
    answer(403, { error: "Only admins can change the organization's model providers" });
    const ask = vi.fn();
    await expect(deleteModelProviderAsking(gateway, ask)).rejects.toThrow(/Only admins/);
    expect(ask).not.toHaveBeenCalled();
  });
});
