import { describe, expect, it } from "vitest";
import { localMailGeneration } from "./account-generation";

describe("localMailGeneration", () => {
  it("bumps only the implicit IMAP cache generation", () => {
    expect(
      localMailGeneration({ accountId: "imap-account", provider: "imap" }),
    ).toBe("imap-account:imap:2");
    expect(
      localMailGeneration({ accountId: "google-account", provider: "google" }),
    ).toBe("google-account");
    expect(
      localMailGeneration({
        accountId: "imap-account",
        provider: "imap",
        generation: "server-generation",
      }),
    ).toBe("server-generation");
  });
});
