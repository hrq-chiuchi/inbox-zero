import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { NewsletterStatus } from "@/generated/prisma/enums";
import { setSenderStatusAction } from "@/utils/actions/unsubscriber";

const {
  createEmailProviderMock,
  setSenderStatusMock,
  setSenderStatusWithAutoArchiveMock,
} = vi.hoisted(() => ({
  createEmailProviderMock: vi.fn(),
  setSenderStatusMock: vi.fn(),
  setSenderStatusWithAutoArchiveMock: vi.fn(),
}));

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: createEmailProviderMock,
}));
vi.mock("@/utils/senders/unsubscribe", () => ({
  setSenderStatus: setSenderStatusMock,
  setSenderStatusWithAutoArchive: setSenderStatusWithAutoArchiveMock,
  unsubscribeSenderAndMark: vi.fn(),
}));

describe("Hostinger sender capability guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "imap",
      }),
    );
    setSenderStatusMock.mockResolvedValue({ email: "sender@example.com" });
  });

  it("rejects native autoarchive without recording success or creating a provider", async () => {
    const result = await setSenderStatusAction("account-1", {
      senderEmail: "sender@example.com",
      status: NewsletterStatus.AUTO_ARCHIVED,
    });

    expect(result?.serverError).toBeTruthy();
    expect(result?.data).toBeUndefined();
    expect(setSenderStatusMock).not.toHaveBeenCalled();
    expect(createEmailProviderMock).not.toHaveBeenCalled();
    expect(setSenderStatusWithAutoArchiveMock).not.toHaveBeenCalled();
  });

  it("rejects a future-email label filter without recording sender status", async () => {
    const result = await setSenderStatusAction("account-1", {
      senderEmail: "sender@example.com",
      status: NewsletterStatus.APPROVED,
      labelId: "label-1",
    });

    expect(result?.serverError).toBeTruthy();
    expect(setSenderStatusMock).not.toHaveBeenCalled();
    expect(createEmailProviderMock).not.toHaveBeenCalled();
  });

  it.each([
    NewsletterStatus.APPROVED,
    NewsletterStatus.UNSUBSCRIBED,
    null,
  ])("records supported sender status %s without accessing native filters", async (status) => {
    const result = await setSenderStatusAction("account-1", {
      senderEmail: "sender@example.com",
      status,
    });

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toMatchObject({ status, autoArchived: false });
    expect(setSenderStatusMock).toHaveBeenCalled();
    expect(createEmailProviderMock).not.toHaveBeenCalled();
    expect(setSenderStatusWithAutoArchiveMock).not.toHaveBeenCalled();
  });
});
