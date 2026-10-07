import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FetchMessageObject } from "imapflow";
import type { ImapMailbox } from "@/utils/imap/client";
import type { ParsedMessage } from "@/utils/types";
import { getImapMailboxSyncPage, syncImapLocalMail } from "@/utils/imap/sync";

type FixtureSnapshot = {
  id: string;
  emailAccountId: string;
  folderPath: string;
  state: unknown;
  expiresAt: Date;
};

const fixture = vi.hoisted(() => ({
  snapshots: new Map<string, FixtureSnapshot>(),
  mappings: new Map<
    string,
    {
      id: string;
      emailAccountId: string;
      folderPath: string;
      uidValidity: string;
      uid: bigint;
      deleted: boolean;
    }
  >(),
  sequence: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/utils/imap/client", () => ({
  ImapMessageNotFoundError: class extends Error {},
  ImapUidValidityChangedError: class extends Error {},
}));
vi.mock("@/utils/prisma", () => ({
  default: {
    imapSyncSnapshot: {
      create: vi.fn(async ({ data }: { data: Omit<FixtureSnapshot, "id"> }) => {
        const id = `snapshot${++fixture.sequence}`;
        fixture.snapshots.set(id, structuredClone({ ...data, id }));
        return { id };
      }),
      findFirst: vi.fn(
        async ({
          where,
        }: {
          where: {
            id?: string;
            emailAccountId: string;
            folderPath?: string;
            AND?: Array<{ state: { path: string[]; equals: string | number } }>;
          };
        }) => {
          const snapshot = where.id
            ? fixture.snapshots.get(where.id)
            : [...fixture.snapshots.values()].find((candidate) => {
                if (
                  candidate.emailAccountId !== where.emailAccountId ||
                  candidate.folderPath !== where.folderPath
                )
                  return false;
                const data = candidate.state as Record<string, unknown>;
                return where.AND?.every(
                  (condition) =>
                    data[condition.state.path[0]] === condition.state.equals,
                );
              });
          return snapshot?.emailAccountId === where.emailAccountId
            ? structuredClone(snapshot)
            : null;
        },
      ),
    },
    imapMessage: {
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: {
            id?: string;
            emailAccountId: string;
            folderPath: string;
            uidValidity: string;
            uid?: bigint;
          };
          data: { deleted: boolean };
        }) => {
          for (const mapping of fixture.mappings.values()) {
            if (
              mapping.emailAccountId === where.emailAccountId &&
              mapping.folderPath === where.folderPath &&
              mapping.uidValidity === where.uidValidity &&
              (!where.id || where.id === mapping.id) &&
              (where.uid === undefined || where.uid === mapping.uid)
            )
              mapping.deleted = data.deleted;
          }
          return { count: 1 };
        },
      ),
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { emailAccountId: string; id: { in: string[] } };
        }) =>
          [...fixture.mappings.values()].filter(
            (mapping) =>
              mapping.emailAccountId === where.emailAccountId &&
              where.id.in.includes(mapping.id),
          ),
      ),
    },
  },
}));

describe("IMAP stable folder snapshots", () => {
  beforeEach(() => {
    fixture.snapshots.clear();
    fixture.mappings.clear();
    fixture.sequence = 0;
    vi.clearAllMocks();
  });

  it("starts at the newest UID window and still traverses older empty ranges", async () => {
    const mailbox = fakeMailbox([row(501)]);
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 20 });
    expect(first.upsertedMessages.map((message) => message.id)).toEqual([
      "acc-INBOX-1-501",
    ]);
    expect(first.hasMore).toBe(true);
    const second = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 20,
    });
    expect(second).toMatchObject({ upsertedMessages: [], hasMore: true });
    const third = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: second.cursor,
      limit: 20,
    });
    expect(third).toMatchObject({ upsertedMessages: [], hasMore: false });
    expect(mailbox.fetchAll.mock.calls.map(([range]) => range)).toEqual([
      "501:501",
      "251:500",
      "1:250",
    ]);
    expect(mailbox.getMessage).not.toHaveBeenCalled();
    expect(
      mailbox.fetchAll.mock.calls.every(([, query]) => !("source" in query)),
    ).toBe(true);
  });

  it("returns recent metadata immediately for sparse high UIDs and replays bounded checkpoints", async () => {
    const uids = [2902, 3001, 5251, 5252, 5501, 5707];
    const mailbox = fakeMailbox(uids.map(row));
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 1 });
    expect(first.upsertedMessages.map((message) => message.id)).toEqual([
      "acc-INBOX-1-5707",
    ]);
    expect(first.hasMore).toBe(true);
    expect(mailbox.fetchAll.mock.calls.map(([range]) => range)).toEqual([
      "5501:5707",
    ]);

    let page = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 1,
    });
    expect(page.upsertedMessages.map((message) => message.id)).toEqual([
      "acc-INBOX-1-5501",
    ]);
    const fetchCount = mailbox.fetchAll.mock.calls.length;
    const replay = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 1,
    });
    expect(replay.upsertedMessages).toEqual(page.upsertedMessages);
    expect(replay.hasMore).toBe(page.hasMore);
    expect(mailbox.fetchAll).toHaveBeenCalledTimes(fetchCount);

    const ids = [...first.upsertedMessages, ...page.upsertedMessages].map(
      (message) => message.id,
    );
    for (let count = 0; count < 30 && page.hasMore; count++) {
      page = await getImapMailboxSyncPage(mailbox.mailbox, {
        cursor: page.cursor,
        limit: 1,
      });
      ids.push(...page.upsertedMessages.map((message) => message.id));
      expect(page.deletedMessageIds).toEqual([]);
      expect(page.removedMessageIds).toEqual([]);
    }
    expect(page.hasMore).toBe(false);
    expect(ids).toHaveLength(uids.length);
    expect(new Set(ids)).toEqual(
      new Set(uids.map((messageUid) => `acc-INBOX-1-${messageUid}`)),
    );
    const ranges = mailbox.fetchAll.mock.calls.map(([range]) =>
      range.split(":").map(Number),
    );
    expect(ranges.map(([start]) => start)).toEqual(
      Array.from({ length: 23 }, (_, index) => 5501 - index * 250),
    );
    expect(ranges.every(([start, end]) => end - start + 1 <= 250)).toBe(true);
    expect(mailbox.getMessage).not.toHaveBeenCalled();
  });

  it("finishes legacy ascending cursors and reconciles their aligned chunks newest first", async () => {
    const mailbox = fakeMailbox([row(1), row(251), row(501)]);
    const firstId = "acc-INBOX-1-1";
    fixture.mappings.set(firstId, {
      id: firstId,
      emailAccountId: "acc",
      folderPath: "INBOX",
      uidValidity: "1",
      uid: 1n,
      deleted: false,
    });
    const expiresAt = new Date(Date.now() + 60_000);
    fixture.snapshots.set("legacyChunk", {
      id: "legacyChunk",
      emailAccountId: "acc",
      folderPath: "INBOX",
      expiresAt,
      state: {
        version: 1,
        kind: "uid-range",
        group: "legacy-group",
        startUid: 1,
        endUid: 250,
        entries: [{ uid: 1, id: firstId, flags: [] }],
        events: [
          {
            kind: "upsert",
            id: firstId,
            message: parsed(firstId, 1, new Set()),
          },
        ],
      },
    });
    const secret = "a".repeat(43);
    fixture.snapshots.set("legacyCursor", {
      id: "legacyCursor",
      emailAccountId: "acc",
      folderPath: "INBOX",
      expiresAt,
      state: {
        version: 1,
        secret,
        mode: "mailbox",
        folderId: "INBOX",
        after: null,
        before: null,
        uidValidity: "1",
        maxUid: 501,
        nextUid: 251,
        idle: false,
        modseq: null,
        exists: 3,
        previousGroup: null,
        previousMaxUid: 0,
        currentGroup: "legacy-group",
        pending: [],
      },
    });
    const cursor = `legacyCursor.${secret}`;
    const second = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor,
      limit: 20,
    });
    expect(second.reset).toBe(false);
    expect(second.upsertedMessages.map((message) => message.id)).toEqual([
      "acc-INBOX-1-251",
    ]);
    expect(second.hasMore).toBe(true);
    const replay = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor,
      limit: 20,
    });
    expect(replay.upsertedMessages).toEqual(second.upsertedMessages);
    expect(mailbox.fetchAll).toHaveBeenCalledTimes(1);
    const third = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: second.cursor,
      limit: 20,
    });
    expect(third.upsertedMessages.map((message) => message.id)).toEqual([
      "acc-INBOX-1-501",
    ]);
    expect(third.hasMore).toBe(false);
    expect(mailbox.fetchAll.mock.calls.map(([range]) => range)).toEqual([
      "251:500",
      "501:501",
    ]);

    mailbox.rows.splice(0, 1);
    mailbox.rows[0].flags = new Set(["\\Flagged"]);
    mailbox.rows.push(row(600), row(751));
    mailbox.fetchAll.mockClear();
    const changed: ParsedMessage[] = [];
    const deleted: string[] = [];
    let page = third;
    for (let count = 0; count < 4; count++) {
      page = await getImapMailboxSyncPage(mailbox.mailbox, {
        cursor: page.cursor,
        limit: 20,
      });
      expect(page.reset).toBe(false);
      changed.push(...page.upsertedMessages);
      deleted.push(...page.deletedMessageIds);
    }
    expect(page.hasMore).toBe(false);
    expect(changed.map((message) => message.id)).toEqual([
      "acc-INBOX-1-751",
      "acc-INBOX-1-600",
      "acc-INBOX-1-251",
    ]);
    expect(changed[2].labelIds).toContain("STARRED");
    expect(deleted).toEqual([firstId]);
    expect(fixture.mappings.get(firstId)?.deleted).toBe(true);
    expect(mailbox.fetchAll.mock.calls.map(([range]) => range)).toEqual([
      "751:751",
      "501:750",
      "251:500",
      "1:250",
    ]);
  });

  it("detects flag changes and expunges without downloading unchanged MIME", async () => {
    const mailbox = fakeMailbox([row(1), row(2)]);
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 20 });
    mailbox.rows[0].flags = new Set(["\\Seen", "\\Flagged"]);
    mailbox.rows.splice(1, 1);
    const second = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 20,
    });
    expect(second.upsertedMessages).toHaveLength(1);
    expect(second.upsertedMessages[0].labelIds).toEqual(["INBOX", "STARRED"]);
    expect(second.deletedMessageIds).toEqual(["acc-INBOX-1-2"]);
    const third = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: second.cursor,
      limit: 20,
    });
    expect(third.upsertedMessages).toEqual([]);
    expect(mailbox.getMessage).not.toHaveBeenCalled();
  });

  it("does not treat the session-specific Recent flag as a content change", async () => {
    const mailbox = fakeMailbox([row(1)]);
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 20 });
    mailbox.rows[0].flags = new Set(["\\Recent"]);
    const next = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 20,
    });
    expect(next.upsertedMessages).toEqual([]);
  });

  it("compares flags case-insensitively without generating duplicate changes", async () => {
    const mailbox = fakeMailbox([row(1)]);
    mailbox.rows[0].flags = new Set(["\\Seen", "\\Flagged"]);
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 20 });
    mailbox.rows[0].flags = new Set(["\\SEEN", "\\flagged"]);
    const next = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 20,
    });
    expect(next.upsertedMessages).toEqual([]);
  });

  it("uses unchanged CONDSTORE state to avoid rescanning metadata, but still checks UIDVALIDITY", async () => {
    const mailbox = fakeMailbox([row(1)]);
    mailbox.modseq = 10n;
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 20 });
    mailbox.fetchAll.mockClear();
    const unchanged = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 20,
    });
    expect(unchanged.upsertedMessages).toEqual([]);
    expect(mailbox.fetchAll).not.toHaveBeenCalled();
    mailbox.modseq = 11n;
    mailbox.rows[0].flags = new Set(["\\Flagged"]);
    const changed = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: unchanged.cursor,
      limit: 20,
    });
    expect(changed.upsertedMessages).toHaveLength(1);
    mailbox.validity = 2n;
    const reset = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: changed.cursor,
      limit: 20,
    });
    expect(reset.reset).toBe(true);
  });

  it("keeps a fixed arrival boundary during pagination and sees later delivery in the next round", async () => {
    const mailbox = fakeMailbox([row(1), row(2)]);
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 1 });
    mailbox.rows.push(row(3));
    const second = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 1,
    });
    expect(
      [...first.upsertedMessages, ...second.upsertedMessages]
        .map((message) => message.id)
        .sort(),
    ).toEqual(["acc-INBOX-1-1", "acc-INBOX-1-2"]);
    expect(second.hasMore).toBe(false);
    const next = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: second.cursor,
      limit: 10,
    });
    expect(next.upsertedMessages.map((message) => message.id)).toEqual([
      "acc-INBOX-1-3",
    ]);
    expect(first.cursor.length).toBeLessThan(160);
    expect(first.cursor).not.toContain("password");
  });

  it("requires reset on cursor tampering, account/folder/bounds changes and expiry", async () => {
    const mailbox = fakeMailbox([row(1), row(2)]);
    const request = {
      phase: "folder-backfill",
      folderId: "INBOX",
      after: 0,
      before: Date.now() + 10_000,
      limit: 1,
    } as const;
    const first = await syncImapLocalMail(mailbox.mailbox, request, {
      emailAccountId: "acc",
    });
    if (
      first.status !== "ok" ||
      first.phase !== "folder-backfill" ||
      !first.result.nextCursor
    )
      throw new Error("Expected a continuation");
    const cursor = first.result.nextCursor;
    const tail = cursor.endsWith("a") ? "b" : "a";
    for (const changed of [
      { ...request, cursor: cursor.slice(0, -1) + tail },
      { ...request, cursor, folderId: "Archive" },
      { ...request, cursor, after: 1 },
    ])
      expect(
        await syncImapLocalMail(mailbox.mailbox, changed, {
          emailAccountId: "acc",
        }),
      ).toEqual({ status: "reset-required", phase: "folder-backfill" });
    const another = fakeMailbox([row(1)], "another");
    expect(
      await syncImapLocalMail(
        another.mailbox,
        { ...request, cursor },
        { emailAccountId: "another" },
      ),
    ).toEqual({ status: "reset-required", phase: "folder-backfill" });
    fixture.snapshots.get(cursor.split(".")[0])!.expiresAt = new Date(0);
    expect(
      await syncImapLocalMail(
        mailbox.mailbox,
        { ...request, cursor },
        { emailAccountId: "acc" },
      ),
    ).toEqual({ status: "reset-required", phase: "folder-backfill" });
  });

  it("persists bounded UID chunks rather than copying a growing mailbox into every cursor", async () => {
    const mailbox = fakeMailbox(
      Array.from({ length: 1000 }, (_, index) => row(index + 1)),
    );
    let page = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 100 });
    for (let count = 0; count < 30 && page.hasMore; count++)
      page = await getImapMailboxSyncPage(mailbox.mailbox, {
        cursor: page.cursor,
        limit: 100,
      });
    expect(page.hasMore).toBe(false);
    for (const snapshot of fixture.snapshots.values()) {
      const data = snapshot.state as {
        entries?: unknown[];
        pending?: unknown[];
        events?: unknown[];
        current?: unknown[];
      };
      expect(data.entries?.length ?? 0).toBeLessThanOrEqual(250);
      expect(data.pending?.length ?? 0).toBeLessThanOrEqual(250);
      expect(data.events?.length ?? 0).toBeLessThanOrEqual(250);
      expect(data.current).toBeUndefined();
    }
  });

  it("does not silently map a reused UID after UIDVALIDITY changes", async () => {
    const mailbox = fakeMailbox([row(1)]);
    const first = await syncImapLocalMail(
      mailbox.mailbox,
      { phase: "folder-changes", folderId: "INBOX", limit: 20 },
      { emailAccountId: "acc" },
    );
    if (first.status !== "ok" || first.phase !== "folder-changes")
      throw new Error("Expected delta");
    mailbox.validity = 2n;
    expect(
      await syncImapLocalMail(
        mailbox.mailbox,
        {
          phase: "folder-changes",
          folderId: "INBOX",
          cursor: first.result.cursor,
          limit: 20,
        },
        { emailAccountId: "acc" },
      ),
    ).toEqual({ status: "reset-required", phase: "folder-changes" });
    expect(fixture.mappings.get("acc-INBOX-1-1")?.deleted).toBe(true);
  });

  it("reports app-moved stable IDs as scope removals, not account-wide deletions", async () => {
    const mailbox = fakeMailbox([row(1)]);
    const first = await getImapMailboxSyncPage(mailbox.mailbox, { limit: 20 });
    fixture.mappings.get("acc-INBOX-1-1")!.folderPath = "Archive";
    mailbox.rows.length = 0;
    const second = await getImapMailboxSyncPage(mailbox.mailbox, {
      cursor: first.cursor,
      limit: 20,
    });
    expect(second.deletedMessageIds).toEqual([]);
    expect(second.removedMessageIds).toEqual(["acc-INBOX-1-1"]);
  });
});

function row(uid: number): FetchMessageObject {
  return {
    uid,
    seq: uid,
    flags: new Set(),
    internalDate: new Date("2026-10-01T00:00:00Z"),
    envelope: { subject: `Message ${uid}` },
  };
}

function fakeMailbox(rows: FetchMessageObject[], emailAccountId = "acc") {
  const fixtureMailbox = {
    rows,
    validity: 1n,
    modseq: undefined as bigint | undefined,
    fetchAll: vi.fn(async (range: string, _query: object) => {
      const [start, end] = range.split(":").map(Number);
      return fixtureMailbox.rows.filter(
        (message) => message.uid >= start && message.uid <= end,
      );
    }),
    getMessage: vi.fn(async (id: string) => parsed(id, 1, new Set())),
    mailbox: undefined as unknown as ImapMailbox,
  };
  fixtureMailbox.mailbox = {
    emailAccountId,
    withConnection: async (callback: (client: unknown) => Promise<unknown>) =>
      callback({
        getMailboxLock: async () => ({ release() {} }),
        get mailbox() {
          return {
            uidValidity: fixtureMailbox.validity,
            highestModseq: fixtureMailbox.modseq,
            uidNext: Math.max(0, ...rows.map((message) => message.uid)) + 1,
            exists: rows.length,
            specialUse: "\\Inbox",
          };
        },
        fetchAll: fixtureMailbox.fetchAll,
      }),
    rememberMessageMetadata: async (
      folderPath: string,
      uidValidity: string,
      message: FetchMessageObject,
    ) => {
      const id = `${emailAccountId}-${folderPath}-${uidValidity}-${message.uid}`;
      fixture.mappings.set(id, {
        id,
        emailAccountId,
        folderPath,
        uidValidity,
        uid: BigInt(message.uid),
        deleted: false,
      });
      return parsed(id, message.uid, message.flags ?? new Set());
    },
    getMessage: fixtureMailbox.getMessage,
    listFolders: async () => [
      {
        id: "INBOX",
        name: "INBOX",
        delimiter: "/",
        total: rows.length,
        unread: rows.length,
      },
    ],
  } as unknown as ImapMailbox;
  return fixtureMailbox;
}

function parsed(id: string, uid: number, flags: Set<string>): ParsedMessage {
  return {
    id,
    threadId: `thread-${uid}`,
    historyId: "",
    parentFolderId: "INBOX",
    internalDate: "1790812800000",
    date: "2026-10-01T00:00:00Z",
    subject: `Message ${uid}`,
    snippet: "",
    inline: [],
    labelIds: [
      "INBOX",
      ...(!flags.has("\\Seen") ? ["UNREAD"] : []),
      ...(flags.has("\\Flagged") ? ["STARRED"] : []),
    ],
    headers: {
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: `Message ${uid}`,
      date: "2026-10-01T00:00:00Z",
    },
  };
}
