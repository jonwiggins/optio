import { describe, it, expect } from "vitest";
import { hostIdentity } from "../local/host-identity.js";

const SAVED = "11111111-1111-4111-8111-111111111111";
const CODER = "22222222-2222-4222-8222-222222222222";
const osHostname = () => "laptop.local";

describe("hostIdentity (what the daemon registers as)", () => {
  it("is the saved id and the OS hostname, with no name, on a paired laptop", () => {
    expect(hostIdentity({ savedHostId: SAVED, env: {}, osHostname })).toEqual({
      hostId: SAVED,
      hostname: "laptop.local",
    });
  });

  it("sends no id before the server has given one", () => {
    expect(hostIdentity({ env: {}, osHostname })).toEqual({ hostname: "laptop.local" });
  });

  it("prefers OPTIO_LOCAL_HOST_ID over the id in local.json", () => {
    const id = hostIdentity({
      savedHostId: SAVED,
      env: { OPTIO_LOCAL_HOST_ID: ` ${CODER} ` },
      osHostname,
    });
    expect(id.hostId).toBe(CODER);
  });

  it("takes the hostname and the name from OPTIO_LOCAL_HOSTNAME", () => {
    expect(
      hostIdentity({
        env: { OPTIO_LOCAL_HOST_ID: CODER, OPTIO_LOCAL_HOSTNAME: "alice-fix-login" },
        osHostname: () => "coder-7f9c-0",
      }),
    ).toEqual({ hostId: CODER, hostname: "alice-fix-login", name: "alice-fix-login" });
  });

  it("lets --name win over OPTIO_LOCAL_HOSTNAME for the name only", () => {
    expect(
      hostIdentity({
        name: "Build box",
        env: { OPTIO_LOCAL_HOSTNAME: "alice-fix-login" },
        osHostname,
      }),
    ).toEqual({ hostname: "alice-fix-login", name: "Build box" });
  });

  it("ignores blank variables", () => {
    expect(
      hostIdentity({
        savedHostId: SAVED,
        name: "  ",
        env: { OPTIO_LOCAL_HOST_ID: "", OPTIO_LOCAL_HOSTNAME: "  " },
        osHostname,
      }),
    ).toEqual({ hostId: SAVED, hostname: "laptop.local" });
  });

  it("keeps the name within what the server accepts", () => {
    const id = hostIdentity({ env: { OPTIO_LOCAL_HOSTNAME: "w".repeat(300) }, osHostname });
    expect(id.name).toHaveLength(100);
    expect(id.hostname).toHaveLength(255);
  });
});
