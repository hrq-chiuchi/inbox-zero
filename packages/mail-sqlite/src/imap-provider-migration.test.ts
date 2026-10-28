import { describe, expect, it } from "vitest";
import { createNodeSqliteDriver } from "./node-sqlite";
import { MAILBOX_SCHEMA_SQL, migrateMailbox } from "./migrations";

describe("IMAP provider migration", () => {
  it("upgrades a pre-IMAP mailbox and accepts an IMAP account", async () => {
    const driver = createNodeSqliteDriver();
    try {
      await driver.write((tx) =>
        tx.exec(
          MAILBOX_SCHEMA_SQL.replace(
            "'google', 'microsoft', 'imap'",
            "'google', 'microsoft'",
          ),
        ),
      );
      await driver.write((tx) => migrateMailbox(tx, "legacy-epoch"));

      expect(
        await driver.read((tx) =>
          tx.query("SELECT name FROM schema_migrations WHERE id = 11"),
        ),
      ).toEqual([{ name: "0011-imap-provider" }]);

      await driver.write((tx) =>
        tx.execute(
          "INSERT INTO accounts(account_id, provider, generation) VALUES (?, 'imap', 'g1')",
          ["imap-account"],
        ),
      );
      expect(
        await driver.read((tx) =>
          tx.query(
            "SELECT provider FROM accounts WHERE account_id = 'imap-account'",
          ),
        ),
      ).toEqual([{ provider: "imap" }]);
    } finally {
      await driver.close();
    }
  });
});
