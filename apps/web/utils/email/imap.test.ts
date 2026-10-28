import { describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/__mocks__/prisma";
import { ImapProvider } from "@/utils/email/imap";
import { ImapMailbox } from "@/utils/imap/client";
import { parseSource } from "@/utils/imap/message";

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

  it("counts draft messages in the intersection of a folder and custom label", async () => {
    const { mailbox, provider } = fixture();
    prisma.imapLabel.findFirst.mockResolvedValue({
      id: "label-1",
      emailAccountId: "account",
      name: "Important",
      keyword: "iz-important",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const fetch = vi.spyOn(mailbox, "fetchMessages").mockResolvedValue({
      messages: [
        message("regular", "alice@example.com"),
        message("draft", "owner@example.com", { labelIds: ["DRAFT"] }),
      ],
    });

    expect(
      await provider.countMessages({
        folderId: "Projects",
        labelId: "label-1",
      }),
    ).toBe(2);
    expect(fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        folderId: "Projects",
        search: { keyword: "iz-important" },
        includeDrafts: true,
      }),
    );
  });

  it("archives every inbox message from one sender and returns the moved count", async () => {
    const { mailbox, provider } = fixture();
    vi.mocked(mailbox.getOrCreateSpecialFolder).mockImplementation(
      async (role) => role,
    );
    vi.spyOn(mailbox, "fetchMessages").mockResolvedValue({
      messages: [
        message("match-1", "Alice <alice@example.com>"),
        message("other", "bob@example.com"),
        message("match-2", "alice@example.com"),
      ],
    });
    const move = vi.spyOn(mailbox, "moveMessages").mockResolvedValue();

    await expect(
      provider.bulkArchiveSenderOrThrow(
        "alice@example.com",
        "owner@example.com",
        "account",
      ),
    ).resolves.toBe(2);
    expect(move).toHaveBeenCalledWith(["match-1", "match-2"], "ARCHIVE");
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

  it("removes one IMAP draft attachment while preserving the other attachment identity", async () => {
    const { mailbox, provider } = fixture();
    const rawDraft = multipartDraft([
      { id: "remove-id", filename: "remove.txt", content: "remove me" },
      { id: "keep-id", filename: "keep.txt", content: "keep me" },
    ]);
    vi.spyOn(provider, "getDraft").mockResolvedValue(
      message("draft-1", "owner@example.com", { labelIds: ["DRAFT"] }),
    );
    vi.spyOn(mailbox, "getRawMessage").mockResolvedValue(rawDraft);
    vi.spyOn(mailbox, "resolveMessage")
      .mockResolvedValueOnce(imapMapping("draft-1", 1n))
      .mockResolvedValueOnce(imapMapping("replacement", 2n));
    const append = vi
      .spyOn(mailbox, "appendMessage")
      .mockResolvedValue(
        message("replacement", "owner@example.com", { labelIds: ["DRAFT"] }),
      );
    const remove = vi.spyOn(mailbox, "removeMessages").mockResolvedValue();
    prisma.$transaction.mockResolvedValue([]);

    const result = await provider.removeDraftAttachment("draft-1", "remove-id");

    expect(remove).toHaveBeenCalledWith(["draft-1"]);
    const rewritten = await parseSource(append.mock.calls[0]![1]);
    expect(
      rewritten.attachments.map((attachment) => attachment.filename),
    ).toEqual(["keep.txt"]);
    expect(
      rewritten.attachments[0]?.headers.get("x-inbox-zero-attachment-id"),
    ).toBe("keep-id");
    expect(result).toEqual({
      messageId: "draft-1",
      attachments: [
        expect.objectContaining({
          id: "keep-id",
          filename: "keep.txt",
          providerAttachmentId: "0",
        }),
      ],
    });
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

function multipartDraft(
  attachments: Array<{ id: string; filename: string; content: string }>,
) {
  const boundary = "securo-boundary";
  const parts = attachments.map(
    ({ id, filename, content }) => `--${boundary}\r
Content-Type: text/plain; name="${filename}"\r
Content-Disposition: attachment; filename="${filename}"\r
Content-Transfer-Encoding: base64\r
X-Inbox-Zero-Attachment-Id: ${id}\r
\r
${Buffer.from(content).toString("base64")}\r
`,
  );
  return Buffer.from(`From: owner@example.com\r
To: recipient@example.com\r
Subject: Draft\r
MIME-Version: 1.0\r
Content-Type: multipart/mixed; boundary="${boundary}"\r
\r
--${boundary}\r
Content-Type: text/plain; charset=utf-8\r
\r
Draft body\r
${parts.join("")}--${boundary}--\r
`);
}

function imapMapping(id: string, uid: bigint) {
  return {
    id,
    emailAccountId: "account",
    folderPath: "Drafts",
    uidValidity: "42",
    uid,
    rfcMessageId: `<${id}@example.com>`,
    threadId: "draft-thread",
    flags: ["\\Draft"],
    internalDate: new Date("2026-06-10T12:00:00Z"),
    deleted: false,
  };
}
