import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImapMailbox } from "@/utils/imap/client";
import type { FetchMessageObject } from "imapflow";
import { createScopedLogger } from "@/utils/logger";
import { baselineImapPolling, pollImapAccount } from "@/utils/imap/poll";

const state = vi.hoisted(() => {
  class AuthenticationError extends Error {}
  class MissingError extends Error {}
  class ValidityError extends Error {}
  return {
    AuthenticationError,
    MissingError,
    ValidityError,
    keys: new Map<string, string>(),
    rows: [] as FetchMessageObject[],
    validity: 1n,
    connection: {
      pollCursor: null as string | null,
      updatedAt: new Date(),
      emailAccount: {
        email: "owner@example.com",
        account: {
          id: "auth-account",
          provider: "imap",
          disconnectedAt: null as Date | null,
        },
      },
    },
    mailbox: undefined as unknown as ImapMailbox,
    createMailbox: vi.fn(),
    process: vi.fn(),
    fetchAll: vi.fn(),
    getMessage: vi.fn(),
    accountUpdate: vi.fn(),
    publishHint: vi.fn(),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/utils/imap/client", () => ({
  createImapMailbox: state.createMailbox,
  ImapAuthenticationError: state.AuthenticationError,
  ImapMessageNotFoundError: state.MissingError,
  ImapUidValidityChangedError: state.ValidityError,
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({ name: "imap" })),
}));
vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: vi.fn(async () => ({
    id: "acc",
    email: "owner@example.com",
    rules: [],
  })),
  validateWebhookAccount: vi.fn(async () => ({
    success: true,
    data: {
      emailAccount: { id: "acc", email: "owner@example.com", rules: [] },
      hasAutomationRules: true,
      hasAiAccess: true,
    },
  })),
}));
vi.mock("@/utils/webhook/process-history-item", () => ({
  processHistoryItem: state.process,
}));
vi.mock("@/utils/redis/local-mail-hints", () => ({
  publishLocalMailHint: state.publishHint,
}));
vi.mock("@/utils/queue/dispatch", () => ({ enqueueBackgroundJob: vi.fn() }));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => state.keys.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      state.keys.set(key, value);
      return "OK";
    }),
  },
}));
vi.mock("@/utils/redis/owned-lock", () => ({
  acquireOwnedLock: vi.fn(async ({ key }: { key: string }) => {
    if (state.keys.has(key)) return null;
    const token = `token-${key}`;
    state.keys.set(key, token);
    return token;
  }),
  clearOwnedLock: vi.fn(
    async ({ key, lockToken }: { key: string; lockToken: string }) => {
      if (state.keys.get(key) !== lockToken) return false;
      state.keys.delete(key);
      return true;
    },
  ),
  markOwnedLockProcessed: vi.fn(
    async ({ key, lockToken }: { key: string; lockToken: string }) => {
      if (state.keys.get(key) !== lockToken) return false;
      state.keys.set(key, "processed");
      return true;
    },
  ),
}));
vi.mock("@/utils/prisma", () => ({
  default: {
    imapConnection: {
      findUnique: vi.fn(async () => structuredClone(state.connection)),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { pollCursor?: string | null; updatedAt?: Date };
          data: { pollCursor?: string; updatedAt?: Date };
        }) => {
          if (
            (where.pollCursor !== undefined &&
              state.connection.pollCursor !== where.pollCursor) ||
            (where.updatedAt &&
              where.updatedAt.getTime() !==
                state.connection.updatedAt.getTime()) ||
            (state.connection.emailAccount.account.disconnectedAt &&
              where.updatedAt)
          )
            return { count: 0 };
          if (data.pollCursor !== undefined)
            state.connection.pollCursor = data.pollCursor;
          state.connection.updatedAt = data.updatedAt ?? new Date();
          return { count: 1 };
        },
      ),
    },
    imapMessage: { updateMany: vi.fn(async () => ({ count: 1 })) },
    account: { updateMany: state.accountUpdate },
  },
}));

const logger = createScopedLogger("imap-poll-test");

describe("server-side IMAP incoming automation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.keys.clear();
    state.rows = [incoming(1, new Date(Date.now() - 86_400_000))];
    state.validity = 1n;
    state.connection.pollCursor = null;
    state.connection.updatedAt = new Date();
    state.connection.emailAccount.account.disconnectedAt = null;
    state.process.mockReset();
    state.process.mockResolvedValue(undefined);
    state.createMailbox.mockReset();
    state.createMailbox.mockImplementation(async () => state.mailbox);
    state.fetchAll.mockImplementation(async (range: string) => {
      const [start, end] = range.split(":").map(Number);
      return state.rows.filter((row) => row.uid >= start && row.uid <= end);
    });
    state.getMessage.mockImplementation(async (id: string) => message(id));
    state.mailbox = {
      emailAccountId: "acc",
      withConnection: async (callback: (client: unknown) => Promise<unknown>) =>
        callback({
          getMailboxLock: async () => ({ release() {} }),
          get mailbox() {
            return {
              uidValidity: state.validity,
              uidNext: Math.max(0, ...state.rows.map((row) => row.uid)) + 1,
              exists: state.rows.length,
            };
          },
          fetchAll: state.fetchAll,
        }),
      rememberMessageMetadata: async (
        _folder: string,
        validity: string,
        row: FetchMessageObject,
      ) => message(`acc-${validity}-${row.uid}`),
      getMessage: state.getMessage,
    } as unknown as ImapMailbox;
  });

  it("baselines old inbox mail without processing or downloading it, then processes new delivery once", async () => {
    await baselineImapPolling(state.mailbox);
    expect(state.fetchAll).not.toHaveBeenCalled();
    expect(state.getMessage).not.toHaveBeenCalled();
    const baseline = JSON.parse(state.connection.pollCursor!);
    expect(baseline.nextUid).toBe(2);
    state.rows.push(incoming(2));
    await pollImapAccount("acc", logger);
    await pollImapAccount("acc", logger);
    expect(state.process).toHaveBeenCalledTimes(1);
    expect(state.process).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "acc-1-2",
        message: expect.objectContaining({ id: "acc-1-2" }),
      }),
      expect.objectContaining({ hasAutomationRules: true, hasAiAccess: true }),
    );
    expect(JSON.parse(state.connection.pollCursor!).nextUid).toBe(3);
  });

  it("ignores flag-only changes and historical copies placed in INBOX", async () => {
    await baselineImapPolling(state.mailbox);
    state.rows[0].flags = new Set(["\\Flagged"]);
    state.rows.push(incoming(2, new Date(Date.now() - 86_400_000)));
    await pollImapAccount("acc", logger);
    expect(state.process).not.toHaveBeenCalled();
    expect(state.getMessage).not.toHaveBeenCalled();
    expect(JSON.parse(state.connection.pollCursor!).nextUid).toBe(3);
  });

  it("does not lose a failed message by advancing its cursor or keeping its retry lock", async () => {
    await baselineImapPolling(state.mailbox);
    state.rows.push(incoming(2));
    state.process.mockRejectedValueOnce(
      new Error("Temporary automation failure"),
    );
    await expect(pollImapAccount("acc", logger)).rejects.toThrow(
      "Temporary automation failure",
    );
    expect(JSON.parse(state.connection.pollCursor!).nextUid).toBe(2);
    expect(state.keys.has("processing-message:owner@example.com:acc-1-2")).toBe(
      false,
    );
    await pollImapAccount("acc", logger);
    expect(JSON.parse(state.connection.pollCursor!).nextUid).toBe(3);
  });

  it("rejects overlap while one account is still processing", async () => {
    await baselineImapPolling(state.mailbox);
    state.rows.push(incoming(2));
    let release!: () => void;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    state.process.mockImplementationOnce(() => {
      started();
      return pending;
    });
    const first = pollImapAccount("acc", logger);
    await running;
    expect(await pollImapAccount("acc", logger)).toEqual({
      processed: 0,
      skipped: true,
    });
    release();
    await first;
    expect(state.process).toHaveBeenCalledTimes(1);
  });

  it("resets a changed UIDVALIDITY without treating historical reused UIDs as deliveries", async () => {
    await baselineImapPolling(state.mailbox);
    state.validity = 2n;
    state.rows.push(incoming(2));
    expect(await pollImapAccount("acc", logger)).toMatchObject({
      reset: true,
      processed: 0,
    });
    expect(state.process).not.toHaveBeenCalled();
    state.rows.push(incoming(3));
    await pollImapAccount("acc", logger);
    expect(state.process).toHaveBeenCalledTimes(1);
    expect(state.process.mock.calls[0][0].messageId).toBe("acc-2-3");
  });

  it("bounds account work and preserves the next unprocessed message", async () => {
    await baselineImapPolling(state.mailbox);
    for (let uid = 2; uid <= 26; uid++) state.rows.push(incoming(uid));
    expect(await pollImapAccount("acc", logger)).toMatchObject({
      processed: 20,
      hasMore: true,
    });
    expect(JSON.parse(state.connection.pollCursor!).nextUid).toBe(22);
    await pollImapAccount("acc", logger);
    expect(state.process).toHaveBeenCalledTimes(25);
    expect(JSON.parse(state.connection.pollCursor!).nextUid).toBe(27);
  });

  it("marks authentication failure disconnected with a credential revision guard, not transient socket failure", async () => {
    await baselineImapPolling(state.mailbox);
    const revision = state.connection.updatedAt;
    state.createMailbox.mockRejectedValueOnce(
      new state.AuthenticationError("Mailbox authentication failed"),
    );
    await expect(pollImapAccount("acc", logger)).rejects.toThrow(
      "Mailbox authentication failed",
    );
    expect(state.accountUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          provider: "imap",
          emailAccount: { id: "acc", imapConnection: { updatedAt: revision } },
        }),
      }),
    );
    state.accountUpdate.mockClear();
    state.createMailbox.mockRejectedValueOnce(new Error("Socket timed out"));
    await expect(pollImapAccount("acc", logger)).rejects.toThrow(
      "Socket timed out",
    );
    expect(state.accountUpdate).not.toHaveBeenCalled();
  });
});

function incoming(uid: number, date = new Date()): FetchMessageObject {
  return {
    uid,
    seq: uid,
    flags: new Set(),
    internalDate: date,
    envelope: { subject: "Fresh delivery" },
  };
}

function message(id: string) {
  return {
    id,
    threadId: id,
    historyId: "",
    internalDate: String(Date.now()),
    date: new Date().toISOString(),
    subject: "Fresh delivery",
    snippet: "",
    inline: [],
    labelIds: ["INBOX", "UNREAD"],
    headers: {
      from: "sender@example.com",
      to: "owner@example.com",
      date: new Date().toISOString(),
      subject: "Fresh delivery",
    },
  };
}
