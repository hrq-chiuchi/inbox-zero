import { describe, expect, it } from "vitest";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const session = { accountId: "imap-account", generation: "g1" };
const from = { streamId: "folder:Work", generation: "g1", checkpoint: null };
const query = {
  accountIds: [session.accountId],
  predicate: {
    kind: "membership" as const,
    membership: "folder" as const,
    id: "Work",
  },
  order: "newest_first" as const,
  pageSize: 25,
  after: null,
};

function patch(folderId: string): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: session.accountId, messageId: "message" },
    reference: {
      provider: "imap",
      messageId: "message",
      conversationId: "thread",
      version: "1",
    },
    fields: {
      subject: "Work message",
      preview: "Body",
      from: "sender@example.test",
      to: ["fixture@example.test"],
      cc: [],
      receivedAtMs: 1000,
      read: false,
      starred: false,
      folderId,
      inboxSection: null,
      labelIds: [],
      categoryIds: [],
      roles: [],
      hasAttachments: false,
    },
  };
}

describe("IMAP sync state", () => {
  it("removes a message from a custom folder without deleting the conversation or erasing a newer destination", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    try {
      await store.ensureAccount({ ...session, provider: "imap" });
      await store.applySyncPage({
        ownerId: "owner",
        page: {
          session,
          requestId: "seed",
          from,
          to: { ...from, checkpoint: "1" },
          changes: [patch("Work")],
          requiredHydration: [],
          roundComplete: true,
        },
      });
      expect(
        (await store.readMailboxView(query)).view.conversations.map(
          (item) => item.key.conversationId,
        ),
      ).toEqual(["thread"]);
      const removal: ProviderChange = {
        kind: "removed_from_scope",
        key: { accountId: session.accountId, messageId: "message" },
        scopeId: "folder:Work",
      };
      await store.applySyncPage({
        ownerId: "owner",
        page: {
          session,
          requestId: "leave-work",
          from: { ...from, checkpoint: "1" },
          to: { ...from, checkpoint: "2" },
          changes: [removal],
          requiredHydration: [],
          roundComplete: true,
        },
      });
      expect((await store.readMailboxView(query)).view.conversations).toEqual(
        [],
      );
      await store.applySyncPage({
        ownerId: "owner",
        page: {
          session,
          requestId: "destination-before-old-removal",
          from: { ...from, checkpoint: "2" },
          to: { ...from, checkpoint: "3" },
          changes: [patch("Other"), removal],
          requiredHydration: [],
          roundComplete: true,
        },
      });
      const destination = await store.readMailboxView({
        ...query,
        predicate: { kind: "membership", membership: "folder", id: "Other" },
      });
      expect(
        destination.view.conversations.map((item) => item.key.conversationId),
      ).toEqual(["thread"]);
    } finally {
      await store.close();
    }
  });

  it("abandons only the expired snapshot while retaining confirmed mail and its checkpoint for a fresh bootstrap", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    try {
      await store.ensureAccount({ ...session, provider: "imap" });
      await store.applySyncPage({
        ownerId: "owner",
        page: {
          session,
          requestId: "seed",
          from,
          to: { ...from, checkpoint: "old" },
          changes: [patch("Work")],
          requiredHydration: [],
          roundComplete: true,
        },
      });
      const scan = {
        session,
        scopeId: "folder:Work",
        bootstrapId: "expired",
        page: "expired-page",
        from: { ...from, checkpoint: "old" },
        catchUpFrom: null,
        nowMs: 1000,
      };
      await store.startBootstrapScan(scan);
      expect(
        await store.discardBootstrapScan({
          session,
          scopeId: scan.scopeId,
          bootstrapId: "unrelated",
        }),
      ).toEqual({ status: "stale" });
      expect(
        (await store.readBootstrapScan({ session, scopeId: scan.scopeId }))
          ?.bootstrapId,
      ).toBe("expired");
      expect(
        await store.discardBootstrapScan({
          session,
          scopeId: scan.scopeId,
          bootstrapId: "expired",
        }),
      ).toEqual({ status: "committed" });
      expect(
        await store.readBootstrapScan({ session, scopeId: scan.scopeId }),
      ).toBeNull();
      expect(
        (await store.readMailboxView(query)).view.conversations.map(
          (item) => item.key.conversationId,
        ),
      ).toEqual(["thread"]);
      const inspection = await store.inspect();
      expect(
        inspection.streams.find((stream) => stream.streamId === from.streamId)
          ?.checkpoint,
      ).toBe("old");
      expect(
        (
          await store.startBootstrapScan({
            ...scan,
            bootstrapId: "fresh",
            page: "fresh-page",
          })
        ).status,
      ).toBe("committed");
    } finally {
      await store.close();
    }
  });
});
