import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  migrateConversationIndex,
  migrateInboxUnreadExcludesArchive,
  migrateMembershipIndex,
} from "./conversation-index";
import type { SqliteDriver } from "./driver";
import { migrateMessageSearchIndex } from "./message-search-index";
import { MAILBOX_SCHEMA_SQL, migrateMailbox } from "./migrations";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const draftContent = {
  to: ["recipient@example.test"],
  cc: [],
  bcc: [],
  subject: "Unsent work",
  editableHtml: "<p>Keep this draft</p>",
  quotedHtml: "",
  attachmentIds: [],
};

const preservedTables = [
  "accounts",
  "messages",
  "message_content",
  "effective_messages",
  "drafts",
  "draft_attachments",
  "operations",
  "operation_targets",
  "sync_streams",
  "profile_state",
  "effective_role_conversations",
  "effective_message_memberships",
];

describe("IMAP provider migration", () => {
  it("commits a populated legacy cache without losing user work or foreign keys", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mail-imap-migration-"));
    const path = join(directory, "mailbox.sqlite");
    const driver = createNodeSqliteDriver(path);
    let driverOpen = true;
    try {
      await seedLegacyCache(driver);
      const before = await snapshot(driver);
      await driver.write((tx) => migrateMailbox(tx, "must-not-replace-epoch"));
      expect(await snapshot(driver)).toEqual(before);
      await assertForeignKeys(driver);
      const migrations = await driver.read((tx) =>
        tx.query(
          "SELECT id, name FROM schema_migrations WHERE id IN (2, 9) ORDER BY id",
        ),
      );
      expect(migrations).toEqual([
        { id: 2, name: "0002-role-conversation-index" },
        { id: 9, name: "0009-imap-provider" },
      ]);
      await driver.write((tx) => migrateMailbox(tx, "another-epoch"));
      expect(await snapshot(driver)).toEqual(before);
      const store = await createSqliteMailStore(driver);
      for (const accountId of ["google-account", "microsoft-account"]) {
        expect(
          await store.readDraft({ accountId, draftId: "draft-1" }),
        ).toMatchObject({
          status: "found",
          draftRevision: 3,
          content: draftContent,
        });
        expect(
          await store.readOperation({ accountId, operationId: "read-1" }),
        ).toMatchObject({
          operation: { status: "retry_wait", attempts: 2 },
        });
        const inbox = await store.readMailboxView({
          accountIds: [accountId],
          predicate: { kind: "role", role: "inbox" },
          order: "newest_first",
          pageSize: 25,
          after: null,
        });
        expect(inbox.revision.databaseEpoch).toBe("legacy-epoch");
        expect(inbox.view.counts.matchingConversations).toBe(1);
        expect(inbox.view.conversations[0]?.key.conversationId).toBe(
          "conversation-1",
        );
        const conversation = await store.readConversation(
          { accountId, conversationId: "conversation-1" },
          { after: null, pageSize: 25 },
        );
        expect(conversation.view.messages[0]).toMatchObject({
          content: { status: "available", text: "Keep this cached body" },
          pendingOperationIds: ["read-1"],
        });
      }
      await store.ensureAccount({
        accountId: "imap-account",
        provider: "imap",
        generation: "imap-generation",
      });
      await store.close();
      driverOpen = false;
      const reopenedDriver = createNodeSqliteDriver(path);
      try {
        const reopened = await createSqliteMailStore(reopenedDriver);
        expect(
          (await reopened.readAccountSyncStates()).map(
            (account) => account.accountId,
          ),
        ).toEqual(["google-account", "imap-account", "microsoft-account"]);
        await assertForeignKeys(reopenedDriver);
      } finally {
        await reopenedDriver.close();
      }
    } finally {
      if (driverOpen) await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts IMAP on a fresh store and builds the existing conversation indexes", async () => {
    const driver = createNodeSqliteDriver();
    try {
      const store = await createSqliteMailStore(driver);
      await store.ensureAccount({
        accountId: "imap-account",
        provider: "imap",
        generation: "g1",
      });
      await store.applySyncPage({
        ownerId: "owner",
        page: {
          session: { accountId: "imap-account", generation: "g1" },
          requestId: "imap-bootstrap",
          from: { streamId: "primary", generation: "g1", checkpoint: null },
          to: { streamId: "primary", generation: "g1", checkpoint: "1" },
          changes: [
            {
              kind: "message_patch",
              key: { accountId: "imap-account", messageId: "imap-message" },
              reference: {
                provider: "imap",
                messageId: "imap-message",
                conversationId: "imap-conversation",
                version: "1",
              },
              fields: {
                subject: "Native IMAP",
                preview: "Cached mail",
                from: "sender@example.test",
                to: ["fixture@example.test"],
                cc: [],
                receivedAtMs: 1000,
                read: false,
                starred: false,
                folderId: "INBOX",
                labelIds: [],
                categoryIds: [],
                roles: ["inbox"],
                hasAttachments: false,
              },
            },
          ],
          requiredHydration: [],
          roundComplete: true,
        },
      });
      const inbox = await store.readMailboxView({
        accountIds: ["imap-account"],
        predicate: { kind: "role", role: "inbox" },
        order: "newest_first",
        pageSize: 25,
        after: null,
      });
      expect(inbox.view.counts.matchingConversations).toBe(1);
      expect(inbox.view.conversations[0]?.key.conversationId).toBe(
        "imap-conversation",
      );
      await assertForeignKeys(driver);
    } finally {
      await driver.close();
    }
  });
});

async function seedLegacyCache(driver: SqliteDriver) {
  await driver.write(async (tx) => {
    await tx.exec(
      MAILBOX_SCHEMA_SQL.replace(
        "'google', 'microsoft', 'imap'",
        "'google', 'microsoft'",
      ),
    );
    await tx.exec("ALTER TABLE accounts ADD COLUMN connection TEXT");
    await tx.exec(
      "INSERT INTO schema_migrations(id, name) VALUES (1, '0001-mailbox')",
    );
    await tx.exec(
      "INSERT INTO profile_state VALUES (1, 'legacy-epoch', 42, NULL)",
    );
    await migrateConversationIndex(tx);
    await migrateMembershipIndex(tx);
    await migrateInboxUnreadExcludesArchive(tx);
    await migrateMessageSearchIndex(tx);
    for (const provider of ["google", "microsoft"]) {
      const accountId = `${provider}-account`;
      await tx.execute(
        "INSERT INTO accounts VALUES (?, ?, 'g1', 'assistant-cursor', 'connected')",
        [accountId, provider],
      );
      await tx.execute(
        `INSERT INTO messages (
        account_id, message_id, conversation_id, provider, version, subject, preview,
        from_address, to_json, cc_json, received_at_ms, read, starred, folder_id,
        label_ids_json, category_ids_json, roles_json, in_inbox, in_sent, in_draft,
        in_trash, in_spam, has_attachments
      ) VALUES (?, 'message-1', 'conversation-1', ?, 'v1', 'Cached mail', 'Keep this message',
        'sender@example.test', '["fixture@example.test"]', '[]', 1000, 0, 1, 'INBOX',
        '[]', '[]', '["inbox"]', 1, 0, 0, 0, 0, 0)`,
        [accountId, provider],
      );
      await tx.execute(
        `INSERT INTO effective_messages (
        account_id, message_id, conversation_id, subject, preview, from_address,
        to_json, received_at_ms, read, starred, folder_id, label_ids_json,
        category_ids_json, roles_json, in_inbox, in_sent, in_draft, in_trash,
        in_spam, has_attachments, pending_operation_ids_json
      ) SELECT account_id, message_id, conversation_id, subject, preview, from_address,
        to_json, received_at_ms, read, starred, folder_id, label_ids_json,
        category_ids_json, roles_json, in_inbox, in_sent, in_draft, in_trash,
        in_spam, has_attachments, '["read-1"]' FROM messages WHERE account_id = ?`,
        [accountId],
      );
      await tx.execute(
        "INSERT INTO message_content(account_id, message_id, version, text, attachments_json) VALUES (?, 'message-1', 'v1', 'Keep this cached body', '[]')",
        [accountId],
      );
      await tx.execute(
        "INSERT INTO draft_attachments VALUES (?, 'attachment-1', 'draft-1', 'note.txt', 'text/plain', 4, 'checksum', 0, NULL, 'local', 1234)",
        [accountId],
      );
      await tx.execute(
        "INSERT INTO drafts VALUES (?, 'draft-1', 3, ?, 0, 1234)",
        [accountId, JSON.stringify(draftContent)],
      );
      await tx.execute(
        `INSERT INTO operations (
        account_id, command_id, status, authority, intent_hash, payload_json,
        attempts, next_attempt_at_ms, error_code, error_retryable, created_at_ms
      ) VALUES (?, 'read-1', 'retry_wait', 'metadata', 'intent-hash', ?, 2, 9999, 'network', 1, 1234)`,
        [
          accountId,
          JSON.stringify({
            accountId,
            commandId: "read-1",
            targets: [{ accountId, messageId: "message-1" }],
            change: { kind: "set_read", read: true },
          }),
        ],
      );
      await tx.execute(
        "INSERT INTO operation_targets VALUES (?, 'read-1', 'message-1', 'conversation-1', NULL, NULL)",
        [accountId],
      );
      await tx.execute(
        "INSERT INTO sync_streams VALUES (?, 'primary', 'g1', 'legacy-checkpoint')",
        [accountId],
      );
    }
  });
}

async function snapshot(driver: SqliteDriver) {
  return driver.read(async (tx) => {
    const rows: Record<string, unknown> = {};
    for (const table of preservedTables)
      rows[table] = await tx.query(`SELECT * FROM ${table} ORDER BY rowid`);
    return rows;
  });
}

async function assertForeignKeys(driver: SqliteDriver) {
  expect(await driver.read((tx) => tx.query("PRAGMA foreign_keys"))).toEqual([
    { foreign_keys: 1 },
  ]);
  expect(
    await driver.read((tx) => tx.query("PRAGMA foreign_key_check")),
  ).toEqual([]);
  expect(
    await driver.read((tx) => tx.query("PRAGMA foreign_key_list(messages)")),
  ).toEqual([
    expect.objectContaining({
      table: "accounts",
      from: "account_id",
      to: "account_id",
    }),
  ]);
  await expect(
    driver.write(async (tx) => {
      const result = await tx.execute(
        "UPDATE messages SET account_id = 'missing-account' WHERE rowid = (SELECT rowid FROM messages LIMIT 1)",
      );
      expect(result.changedRows).toBe(1);
    }),
  ).rejects.toThrow(/FOREIGN KEY/);
}
