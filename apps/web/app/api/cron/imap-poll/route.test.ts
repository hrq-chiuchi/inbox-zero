import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "./route";
import type * as TestHelpers from "@/__tests__/helpers";

const fixture = vi.hoisted(() => ({
  enqueue: vi.fn(),
  env: { CRON_SECRET: "cron-secret" as string | undefined },
}));
vi.mock("@/env", () => ({ env: fixture.env }));
vi.mock("@/utils/imap/poll", () => ({ enqueueImapPolling: fixture.enqueue }));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof TestHelpers
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});

describe("protected native IMAP polling cron", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fixture.env.CRON_SECRET = "cron-secret";
    fixture.enqueue.mockResolvedValue({ queued: 2, skipped: false });
  });

  it("rejects absent and incorrect credentials without dispatching accounts", async () => {
    for (const authorization of [undefined, "Bearer wrong-secret"]) {
      const response = await GET(
        new Request("http://localhost/api/cron/imap-poll", {
          headers: authorization ? { authorization } : undefined,
        }),
      );
      expect(response.status).toBe(401);
    }
    const response = await POST(
      new Request("http://localhost/api/cron/imap-poll", {
        method: "POST",
        body: JSON.stringify({ CRON_SECRET: "wrong-secret" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("fails closed if CRON_SECRET is not configured", async () => {
    fixture.env.CRON_SECRET = undefined;
    const response = await GET(
      new Request("http://localhost/api/cron/imap-poll", {
        headers: { authorization: "Bearer undefined" },
      }),
    );
    expect(response.status).toBe(401);
    expect(fixture.enqueue).not.toHaveBeenCalled();
  });

  it("dispatches polling from either established authorized cron invocation", async () => {
    const get = await GET(
      new Request("http://localhost/api/cron/imap-poll", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );
    expect(get.status).toBe(200);
    expect(await get.json()).toEqual({ queued: 2, skipped: false });
    const post = await POST(
      new Request("http://localhost/api/cron/imap-poll", {
        method: "POST",
        body: JSON.stringify({ CRON_SECRET: "cron-secret" }),
      }),
    );
    expect(post.status).toBe(200);
    expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  });
});
