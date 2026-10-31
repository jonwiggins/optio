import { afterEach, describe, expect, it, vi } from "vitest";
import { emailFailureIsPermanent, retryPolicy } from "./outbox.js";
afterEach(() => vi.unstubAllEnvs());
describe("retries", () => {
  it("tries ten times from 30 seconds by default, as the deployment says otherwise", () => {
    expect(retryPolicy()).toEqual({ attempts: 10, baseMs: 30_000, deadLetterDays: 30 });
    vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "4");
    vi.stubEnv("OPTIO_NOTIFY_RETRY_BASE_SECONDS", "5");
    vi.stubEnv("OPTIO_NOTIFY_DEAD_LETTER_DAYS", "7");
    expect(retryPolicy()).toEqual({ attempts: 4, baseMs: 5000, deadLetterDays: 7 });
    vi.stubEnv("OPTIO_NOTIFY_RETRY_ATTEMPTS", "nonsense");
    vi.stubEnv("OPTIO_NOTIFY_RETRY_BASE_SECONDS", "0");
    expect(retryPolicy().attempts).toBe(10);
    expect(retryPolicy().baseMs).toBe(10);
  });

  it("gives up on an email at once only when the relay refused it for good", () => {
    expect(emailFailureIsPermanent("No valid recipient address")).toBe(true);
    expect(
      emailFailureIsPermanent(
        "The relay refused every recipient: a@example.test (550 5.1.1 no such user)",
      ),
    ).toBe(true);
    // A 4xx (greylisting, a full mailbox for now) may pass.
    expect(
      emailFailureIsPermanent(
        "The relay refused every recipient: a@example.test (450 4.2.1 try later); b@example.test (550 no)",
      ),
    ).toBe(false);
    expect(emailFailureIsPermanent("The relay refused the message: 554 5.7.1 spam")).toBe(true);
    expect(emailFailureIsPermanent("The relay refused the message: 451 try later")).toBe(false);
    expect(emailFailureIsPermanent("Could not reach the relay relay:25 (ECONNREFUSED)")).toBe(
      false,
    );
    // A wrong password is an admin's to fix; the retries wait for it.
    expect(emailFailureIsPermanent("The relay refused the user name or password (535 …)")).toBe(
      false,
    );
  });
});
