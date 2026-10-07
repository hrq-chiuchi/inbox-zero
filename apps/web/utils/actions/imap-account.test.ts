import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { connectHostingerAccountAction } from "./imap-account";
import type { env } from "@/env";
import type { Account, EmailAccount } from "@/generated/prisma/client";

const { verifyCredentials, baseline, acquireLease, releaseLease, encryption } =
  vi.hoisted(() => ({
    verifyCredentials: vi.fn(),
    baseline: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn(),
    encryption: {
      secret: "test-encryption-secret",
      salt: "test-encryption-salt",
    },
  }));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "login@example.com" },
  })),
  autoJoinOrganization: vi.fn(async () => {}),
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<{ env: typeof env }>();
  return {
    env: {
      ...actual.env,
      AUTO_JOIN_ORGANIZATION_ENABLED: false,
      get EMAIL_ENCRYPT_SECRET() {
        return encryption.secret;
      },
      get EMAIL_ENCRYPT_SALT() {
        return encryption.salt;
      },
    },
  };
});
vi.mock("@/utils/imap/client", () => ({
  verifyHostingerCredentials: verifyCredentials,
  ImapMailbox: class {
    readonly emailAccountId: string;
    readonly credentials: unknown;

    constructor(emailAccountId: string, credentials: unknown) {
      this.emailAccountId = emailAccountId;
      this.credentials = credentials;
    }
  },
}));
vi.mock("@/utils/imap/poll", () => ({
  baselineImapPolling: baseline,
  acquireImapPollingLease: acquireLease,
}));
vi.mock("@/utils/redis/owned-lock", () => ({ clearOwnedLock: releaseLease }));
vi.mock("@/utils/premium/seats", () => ({
  updateAccountSeats: vi.fn(async () => {}),
}));

const input = {
  email: "mailbox@example.com",
  password: "private mailbox password",
  name: "Mailbox",
  smtpPort: 465 as const,
};

describe("connectHostingerAccountAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encryption.secret = "test-encryption-secret";
    encryption.salt = "test-encryption-salt";
    verifyCredentials.mockReset().mockResolvedValue(undefined);
    baseline.mockReset().mockResolvedValue(undefined);
    acquireLease.mockReset().mockResolvedValue({
      key: "imap-poll:account:mailbox-1",
      lockToken: "lease-1",
    });
    releaseLease.mockReset().mockResolvedValue(true);
    prisma.emailAccount.findFirst.mockResolvedValue(null);
    prisma.account.findFirst.mockResolvedValue(null);
    prisma.user.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockResolvedValue([]);
    prisma.account.update.mockResolvedValue({ id: "provider-1" } as Account);
  });

  it("normalizes identity without changing the password and returns no secret", async () => {
    const password = "  password with significant spaces  ";
    const result = await connectHostingerAccountAction({
      ...input,
      email: "  MAILBOX@Example.com  ",
      password,
    });
    expect(result?.serverError).toBeUndefined();
    expect(verifyCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ email: input.email, password }),
    );
    expect(prisma.account.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          provider: "imap",
          type: "email",
          userId: "user-1",
          providerAccountId: input.email,
        }),
      }),
    );
    expect(result?.data).toEqual({ emailAccountId: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain(password);
    expect(baseline).toHaveBeenCalledOnce();
  });

  it("never persists invalid credentials or leaks provider error contents", async () => {
    verifyCredentials.mockRejectedValue(
      new Error(`Authentication failed for ${input.password}`),
    );
    const result = await connectHostingerAccountAction(input);
    expect(result?.serverError).toContain("Could not verify");
    expect(JSON.stringify(result)).not.toContain(input.password);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.imapConnection.create).not.toHaveBeenCalled();
  });

  it("requires actual encryption key material before verification or writes", async () => {
    encryption.secret = " ";
    const result = await connectHostingerAccountAction(input);
    expect(result?.serverError).toContain("encryption is not configured");
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a mailbox owned by someone else even with valid supplied credentials", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(mailbox("other-user"));
    const result = await connectHostingerAccountAction({
      ...input,
      emailAccountId: "mailbox-1",
    });
    expect(result?.serverError).toContain("another user");
    expect(verifyCredentials).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects an orphan provider account belonging to another user", async () => {
    prisma.account.findFirst.mockResolvedValue({
      id: "provider-1",
      userId: "other-user",
    } as Account);
    const result = await connectHostingerAccountAction(input);
    expect(result?.serverError).toContain("another user");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not overwrite a same-owner mailbox without explicit matching reconnect identity", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(mailbox());
    prisma.account.findFirst.mockResolvedValue({
      id: "provider-1",
      userId: "user-1",
    } as Account);
    const result = await connectHostingerAccountAction({
      ...input,
      emailAccountId: "wrong-mailbox",
    });
    expect(result?.serverError).toContain("Hostinger account not found");
    expect(prisma.imapConnection.update).not.toHaveBeenCalled();
  });

  it("reconnects only the matching owner and preserves the polling cursor", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(mailbox());
    prisma.account.findFirst.mockResolvedValue({
      id: "provider-1",
      userId: "user-1",
    } as Account);
    const result = await connectHostingerAccountAction({
      ...input,
      emailAccountId: "mailbox-1",
      smtpPort: 587,
    });
    expect(result?.serverError).toBeUndefined();
    expect(prisma.imapConnection.update).toHaveBeenCalledWith({
      where: expect.objectContaining({
        emailAccountId: "mailbox-1",
        emailAccount: expect.objectContaining({
          userId: "user-1",
          accountId: "provider-1",
        }),
      }),
      data: { password: input.password, smtpPort: 587 },
      select: { id: true },
    });
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.imapConnection.create).not.toHaveBeenCalled();
    expect(verifyCredentials.mock.invocationCallOrder[0]).toBeLessThan(
      acquireLease.mock.invocationCallOrder[0],
    );
    expect(releaseLease).toHaveBeenCalledWith({
      key: "imap-poll:account:mailbox-1",
      lockToken: "lease-1",
    });
  });

  it("does not mark syncing connected when the initial polling baseline fails", async () => {
    baseline.mockRejectedValue(new Error("IMAP disconnected"));
    const result = await connectHostingerAccountAction(input);
    expect(result?.serverError).toContain("syncing could not start");
    expect(prisma.account.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { disconnectedAt: null } }),
    );
  });

  it("does not replace credentials while another poll worker holds the account lease", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(mailbox());
    prisma.account.findFirst.mockResolvedValue({
      id: "provider-1",
      userId: "user-1",
    } as Account);
    acquireLease.mockResolvedValue(null);
    const result = await connectHostingerAccountAction({
      ...input,
      emailAccountId: "mailbox-1",
    });
    expect(result?.serverError).toContain("syncing right now");
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.imapConnection.update).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("releases the account lease after a failed reconnect baseline", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(mailbox());
    prisma.account.findFirst.mockResolvedValue({
      id: "provider-1",
      userId: "user-1",
    } as Account);
    baseline.mockRejectedValue(new Error("IMAP disconnected"));
    const result = await connectHostingerAccountAction({
      ...input,
      emailAccountId: "mailbox-1",
    });
    expect(result?.serverError).toContain("syncing could not start");
    expect(releaseLease).toHaveBeenCalledWith({
      key: "imap-poll:account:mailbox-1",
      lockToken: "lease-1",
    });
  });

  it("releases the account lease after rejected credential persistence", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(mailbox());
    prisma.account.findFirst.mockResolvedValue({
      id: "provider-1",
      userId: "user-1",
    } as Account);
    prisma.$transaction.mockRejectedValueOnce(
      new Error("Database unavailable"),
    );
    const result = await connectHostingerAccountAction({
      ...input,
      emailAccountId: "mailbox-1",
    });
    expect(result?.serverError).toContain("Could not save");
    expect(baseline).not.toHaveBeenCalled();
    expect(releaseLease).toHaveBeenCalledWith({
      key: "imap-poll:account:mailbox-1",
      lockToken: "lease-1",
    });
  });
});

function mailbox(userId = "user-1") {
  return {
    id: "mailbox-1",
    email: input.email,
    userId,
    accountId: "provider-1",
    account: { userId, provider: "imap", providerAccountId: input.email },
  } as EmailAccount & { account: Account };
}
