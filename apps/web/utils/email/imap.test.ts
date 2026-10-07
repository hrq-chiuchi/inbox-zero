import { describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/__mocks__/prisma";
import { ImapProvider } from "@/utils/email/imap";
import { ImapMailbox } from "@/utils/imap/client";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));
vi.mock("@/utils/imap/sync", () => ({
  getImapMailboxSyncPage: vi.fn(),
  syncImapLocalMail: vi.fn(),
}));

function message(
  id: string,
  sender: string,
  overrides: Partial<ParsedMessage> = {},
): ParsedMessage {
  return {
    id,
    threadId: `thread-${id}`,
    historyId: "",
    date: "2026-06-10T12:00:00Z",
    internalDate: String(new Date("2026-06-10T12:00:00Z").getTime()),
    headers: {
      from: sender,
      to: "owner@example.com",
      subject: "Status",
      date: "2026-06-10T12:00:00Z",
    },
    subject: "Status",
    textPlain: "Body",
    snippet: "Body",
    inline: [],
    parentFolderId: "INBOX",
    labelIds: ["INBOX", "UNREAD"],
    ...overrides,
  };
}
function fixture() {
  const mailbox = new ImapMailbox("account", {
    email: "owner@example.com",
    password: "not-real",
    smtpPort: 465,
  });
  const provider = new ImapProvider(mailbox);
  vi.spyOn(mailbox, "listFolders").mockResolvedValue([
    {
      id: "INBOX",
      name: "INBOX",
      delimiter: "/",
      specialUse: "\\Inbox",
      total: 10,
      unread: 5,
    },
  ]);
  vi.spyOn(mailbox, "getOrCreateSpecialFolder").mockResolvedValue("INBOX");
  prisma.imapLabel.findMany.mockResolvedValue([]);
  return { mailbox, provider };
}

describe("IMAP provider", () => {
  it("reports unread and standard-folder counts when server folder IDs differ from system-label IDs", async () => {
    const { mailbox, provider } = fixture();
    vi.mocked(mailbox.listFolders).mockResolvedValue([
      {
        id: "INBOX",
        name: "INBOX",
        delimiter: "/",
        specialUse: "\\Inbox",
        total: 10,
        unread: 5,
      },
      {
        id: "Sent",
        name: "Sent",
        delimiter: "/",
        specialUse: "\\Sent",
        total: 3,
        unread: 1,
      },
      { id: "Projects", name: "Projects", delimiter: "/", total: 4, unread: 2 },
    ]);
    expect((await provider.getLabelById("UNREAD"))?.threadsTotal).toBe(8);
    expect((await provider.getLabelById("SENT"))?.threadsTotal).toBe(3);
    expect((await provider.getLabelById("INBOX"))?.threadsTotal).toBe(10);
  });

  it("searches through every source page before applying filters and returning a stable result page", async () => {
    const { mailbox, provider } = fixture();
    const matching = message("wanted", "alice@example.com");
    const fetch = vi
      .spyOn(mailbox, "fetchMessages")
      .mockResolvedValueOnce({
        messages: [message("other", "bob@example.com")],
        nextPageToken: "imap-page:snapshot:1",
      })
      .mockResolvedValueOnce({ messages: [matching] });
    vi.spyOn(mailbox, "getMessage").mockResolvedValue(matching);
    prisma.imapSyncSnapshot.create.mockResolvedValue({
      id: "result",
      emailAccountId: "account",
      folderPath: "scope",
      state: { ids: ["wanted"] },
      expiresAt: new Date(Date.now() + 1000),
    });
    const page = await provider.getMessagesFromSender({
      senderEmail: "alice@example.com",
      maxResults: 1,
    });
    expect(page.messages.map((item) => item.id)).toEqual(["wanted"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]?.search?.from).toBe("alice@example.com");
    expect(page.nextPageToken).toBeUndefined();
  });

  it("rejects another query's cursor rather than broadening or returning an empty page", async () => {
    const { provider } = fixture();
    prisma.imapSyncSnapshot.findFirst.mockResolvedValue(null);
    await expect(
      provider.getMessagesFromSender({
        senderEmail: "alice@example.com",
        pageToken: "imap-result:foreign:0",
      }),
    ).rejects.toThrow("Invalid mailbox sync cursor");
    expect(prisma.imapSyncSnapshot.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ emailAccountId: "account" }),
      }),
    );
  });

  it("looks up only the account-scoped mapped conversation and does not rescan the mailbox", async () => {
    const { mailbox, provider } = fixture();
    const fetch = vi.spyOn(mailbox, "fetchMessages");
    prisma.imapMessage.findMany.mockResolvedValue([
      {
        id: "reply",
        emailAccountId: "account",
        folderPath: "Sent",
        uidValidity: "42",
        uid: 7n,
        rfcMessageId: "<reply@example.com>",
        threadId: "conversation",
        flags: ["\\Seen"],
        internalDate: new Date(),
        deleted: false,
      },
    ]);
    vi.spyOn(mailbox, "getMessage").mockResolvedValue(
      message("reply", "owner@example.com", {
        threadId: "conversation",
        labelIds: ["SENT"],
      }),
    );
    expect(
      (await provider.getThread("conversation")).messages.map(
        (item) => item.id,
      ),
    ).toEqual(["reply"]);
    expect(fetch).not.toHaveBeenCalled();
    expect(prisma.imapMessage.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: "account",
          threadId: "conversation",
          deleted: false,
        },
      }),
    );
  });

  it("surfaces unsupported filters rather than returning invented server capability", async () => {
    const { provider } = fixture();
    await expect(provider.getFiltersList()).rejects.toThrow("not supported");
    await expect(
      provider.createFilter({ from: "alice@example.com" }),
    ).rejects.toThrow("not supported");
    await expect(provider.watchEmails()).rejects.toThrow("polling");
  });
});
