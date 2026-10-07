import { describe, expect, it, vi } from "vitest";
import type { ImapFlow } from "imapflow";
import type { ImapMessage } from "@/generated/prisma/client";
import prisma from "@/utils/__mocks__/prisma";
import {
  createTestImapMailbox,
  ImapCapabilityError,
  ImapMailbox,
  ImapUidValidityChangedError,
} from "@/utils/imap/client";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));
const credentials = {
  email: "owner@example.com",
  password: "do-not-log",
  smtpPort: 465 as const,
};
const mapping: ImapMessage = {
  id: "stable-id",
  emailAccountId: "account",
  folderPath: "INBOX",
  uidValidity: "42",
  uid: 7n,
  rfcMessageId: "<message@example.com>",
  threadId: "thread",
  flags: [],
  internalDate: new Date(),
  deleted: false,
};

function fixture(capabilities: string[] = ["UIDPLUS"]) {
  const mailbox = new ImapMailbox("account", credentials);
  const release = vi.fn();
  const client = {
    mailbox: { uidValidity: 42n, exists: 1, uidNext: 8 },
    capabilities: new Map(capabilities.map((capability) => [capability, true])),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    list: vi
      .fn()
      .mockResolvedValue([{ path: "INBOX", flags: new Set<string>() }]),
    search: vi.fn().mockResolvedValue([]),
    fetchOne: vi.fn(),
    fetchAll: vi
      .fn()
      .mockResolvedValue([{ uid: 7, flags: new Set(["\\Seen"]) }]),
    messageMove: vi.fn(),
    messageDelete: vi.fn(),
    messageFlagsAdd: vi.fn(),
    messageFlagsRemove: vi.fn(),
  };
  vi.spyOn(mailbox, "withConnection").mockImplementation(async (callback) =>
    callback(client as unknown as ImapFlow),
  );
  prisma.imapMessage.findFirst.mockResolvedValue({ ...mapping });
  prisma.imapMessage.updateMany.mockResolvedValue({ count: 1 });
  return { mailbox, client, release };
}

describe("IMAP stable identity and selective mutations", () => {
  it("rejects a reused UID after UIDVALIDITY changes before reading any source", async () => {
    const { mailbox, client, release } = fixture();
    client.mailbox.uidValidity = 99n;
    await expect(mailbox.getMessage("stable-id")).rejects.toBeInstanceOf(
      ImapUidValidityChangedError,
    );
    expect(client.fetchOne).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(prisma.imapMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId: "account",
          uidValidity: "42",
        }),
        data: { deleted: true },
      }),
    );
  });

  it("preserves application IDs across UIDPLUS moves", async () => {
    const { mailbox, client } = fixture();
    client.messageMove.mockResolvedValue({
      uidValidity: 84n,
      uidMap: new Map([[7, 19]]),
    });
    await mailbox.moveMessages(["stable-id"], "Archive");
    expect(client.messageMove).toHaveBeenCalledWith([7], "Archive", {
      uid: true,
    });
    expect(prisma.imapMessage.updateMany).toHaveBeenCalledWith({
      where: { id: "stable-id", emailAccountId: "account" },
      data: { folderPath: "Archive", uidValidity: "84", uid: 19n },
    });
  });

  it("refuses nonselective deletion before marking any requested UID Deleted", async () => {
    const { mailbox, client } = fixture([]);
    await expect(mailbox.removeMessages(["stable-id"])).rejects.toBeInstanceOf(
      ImapCapabilityError,
    );
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("issues only requested UID deletion and never uses mailbox-wide expunge", async () => {
    const { mailbox, client } = fixture();
    client.messageDelete.mockResolvedValue(true);
    await mailbox.removeMessages(["stable-id"]);
    expect(client.messageDelete).toHaveBeenCalledWith([7], { uid: true });
  });

  it("preserves fresh server flags when adding a keyword rather than overwriting stale cached flags", async () => {
    const { mailbox, client } = fixture();
    client.messageFlagsAdd.mockResolvedValue(true);
    await mailbox.setFlags(["stable-id"], ["iz-classification"], true);
    expect(prisma.imapMessage.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { flags: ["\\Seen", "iz-classification"] },
      }),
    );
  });

  it("excludes credentials from JSON and confines endpoint overrides to the explicit local test factory", () => {
    const mailbox = new ImapMailbox("account", credentials);
    expect(JSON.stringify(mailbox)).not.toContain(credentials.password);
    expect(() =>
      createTestImapMailbox("account", credentials, {
        host: "private.example" as "127.0.0.1",
        imapPort: 993,
        smtpPort: 465,
        secure: true,
      }),
    ).toThrow("only available in tests");
  });
});

describe("IMAP folder search results", () => {
  function searchFixture() {
    const result = fixture();
    prisma.imapSyncSnapshot.create.mockClear().mockResolvedValue({
      id: "snapshot",
      emailAccountId: "account",
      folderPath: "search",
      state: { entries: [] },
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    return result;
  }

  it("skips empty folders and continues searching populated folders", async () => {
    const { mailbox, client, release } = searchFixture();
    client.list.mockResolvedValue([
      { path: "Empty", flags: new Set<string>() },
      { path: "INBOX", flags: new Set<string>() },
    ]);
    client.getMailboxLock.mockImplementation(async (path) => {
      client.mailbox.exists = path === "Empty" ? 0 : 1;
      client.mailbox.uidNext = path === "Empty" ? 1 : 8;
      return { release };
    });
    await expect(mailbox.fetchMessages()).resolves.toEqual({
      messages: [],
      nextPageToken: undefined,
    });
    expect(client.search).toHaveBeenCalledTimes(1);
    expect(client.search).toHaveBeenCalledWith({ draft: false }, { uid: true });
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("accepts a successful no-match search in a populated folder", async () => {
    const { mailbox, client, release } = searchFixture();
    // No existing UID can match this range; SEARCH still succeeds with [].
    const search = { uid: `${client.mailbox.uidNext}:4294967295` };
    await expect(
      mailbox.fetchMessages({ folderId: "INBOX", search }),
    ).resolves.toEqual({ messages: [], nextPageToken: undefined });
    expect(client.search).toHaveBeenCalledWith(
      { ...search, draft: false },
      { uid: true },
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not turn a failed search in a populated folder into an empty snapshot", async () => {
    const { mailbox, client, release } = searchFixture();
    client.search.mockResolvedValue(false);
    await expect(mailbox.fetchMessages({ folderId: "INBOX" })).rejects.toThrow(
      'IMAP search did not complete in folder "INBOX".',
    );
    expect(release).toHaveBeenCalledTimes(1);
    expect(prisma.imapSyncSnapshot.create).not.toHaveBeenCalled();
  });
});

describe("IMAP envelope search", () => {
  function envelopeFixture() {
    const result = fixture();
    const fetch = vi.fn((_uids: number[]) =>
      (async function* () {
        yield {
          uid: 3,
          internalDate: new Date("2026-06-01T10:00:00Z"),
          envelope: {
            from: [{ address: "Alice@Example.com" }],
            to: [{ address: "owner@example.com" }],
          },
        };
      })(),
    );
    Object.assign(result.client, { fetch });
    return { ...result, fetch };
  }

  it("returns addresses and dates without downloading message sources", async () => {
    const { mailbox, client, fetch } = envelopeFixture();
    client.search.mockResolvedValue([3]);
    await expect(
      mailbox.searchEnvelopes({ search: { from: "alice@example.com" } }),
    ).resolves.toEqual([
      {
        folder: "INBOX",
        uidValidity: "42",
        uid: 3,
        internalDate: new Date("2026-06-01T10:00:00Z"),
        from: ["alice@example.com"],
        to: ["owner@example.com"],
      },
    ]);
    expect(client.search).toHaveBeenCalledWith(
      { from: "alice@example.com", draft: false },
      { uid: true },
    );
    expect(fetch).toHaveBeenCalledWith(
      [3],
      { envelope: true, internalDate: true, uid: true },
      { uid: true },
    );
    expect(client.fetchOne).not.toHaveBeenCalled();
  });

  it("skips drafts, excluded roles and empty folders without searching them", async () => {
    const { mailbox, client, release, fetch } = envelopeFixture();
    client.list.mockResolvedValue([
      { path: "INBOX.Drafts", flags: new Set<string>() },
      { path: "INBOX.Junk", flags: new Set<string>() },
      { path: "INBOX.Trash", flags: new Set<string>(), specialUse: "\\Trash" },
      { path: "INBOX.Archive", flags: new Set<string>() },
    ]);
    client.mailbox.exists = 0;
    await expect(
      mailbox.searchEnvelopes({
        search: { from: "alice@example.com" },
        excludeRoles: ["SPAM", "TRASH"],
      }),
    ).resolves.toEqual([]);
    expect(client.getMailboxLock).toHaveBeenCalledTimes(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX.Archive", {
      readOnly: true,
    });
    expect(client.search).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("drops a cutoff that is not in the past, which WITHIN servers reject as OLDER 0", async () => {
    const { mailbox, client } = envelopeFixture();
    const past = new Date(Date.now() - 7 * 86_400_000);
    await mailbox.searchEnvelopes({
      search: {
        from: "a@example.com",
        before: new Date(Date.now() + 86_400_000),
      },
    });
    await mailbox.searchEnvelopes({
      search: { from: "a@example.com", before: past },
    });
    prisma.imapSyncSnapshot.create.mockResolvedValue({
      id: "snapshot",
      emailAccountId: "account",
      folderPath: "search",
      state: { entries: [] },
      expiresAt: new Date(Date.now() + 30 * 60_000),
    });
    await mailbox.fetchMessages({
      folderId: "INBOX",
      search: { before: new Date(Date.now() + 86_400_000) },
    });
    expect(client.search.mock.calls.map(([search]) => search)).toEqual([
      { from: "a@example.com", draft: false },
      { from: "a@example.com", before: past, draft: false },
      { draft: false },
    ]);
  });

  it("names the folder when the server rejects the search", async () => {
    const { mailbox, client, release } = envelopeFixture();
    client.search.mockResolvedValue(false);
    await expect(
      mailbox.searchEnvelopes({ search: { from: "alice@example.com" } }),
    ).rejects.toThrow('IMAP search did not complete in folder "INBOX".');
    expect(release).toHaveBeenCalledTimes(1);
  });
});
