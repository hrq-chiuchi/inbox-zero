import "server-only";

import { z } from "zod";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/prisma";
import {
  createImapMailbox,
  type ImapMailbox,
  ImapAuthenticationError,
  ImapMessageNotFoundError,
  ImapUidValidityChangedError,
} from "@/utils/imap/client";
import { createEmailProvider } from "@/utils/email/provider";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import {
  acquireOwnedLock,
  clearOwnedLock,
  markOwnedLockProcessed,
} from "@/utils/redis/owned-lock";
import { redis } from "@/utils/redis";
import { publishLocalMailHint } from "@/utils/redis/local-mail-hints";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import type { Logger } from "@/utils/logger";

const cursorSchema = z.object({
  version: z.literal(1),
  uidValidity: z.string().regex(/^\d+$/),
  nextUid: z.number().int().min(1).max(4_294_967_296),
  receivedAfterMs: z.number().int().nonnegative(),
});
export const imapPollBody = z.object({
  emailAccountId: z.string().min(1).max(256),
});
const POLL_WINDOW = 250;
const MESSAGE_BATCH = 20;
const POLL_LOCK_SECONDS = 600;
const ACCOUNT_BATCH = 100;

export async function acquireImapPollingLease(emailAccountId: string) {
  const key = `imap-poll:account:${emailAccountId}`;
  const lockToken = await acquireOwnedLock({
    key,
    processingTtlSeconds: POLL_LOCK_SECONDS,
  });
  return lockToken ? { key, lockToken } : null;
}

export async function baselineImapPolling(mailbox: ImapMailbox) {
  const connection = await prisma.imapConnection.findUnique({
    where: { emailAccountId: mailbox.emailAccountId },
    select: { pollCursor: true },
  });
  if (!connection) throw new Error("IMAP connection is missing");
  if (connection.pollCursor) {
    cursorSchema.parse(JSON.parse(connection.pollCursor));
    return;
  }
  const baseline = await readInboxBaseline(mailbox);
  await prisma.imapConnection.updateMany({
    where: { emailAccountId: mailbox.emailAccountId, pollCursor: null },
    data: { pollCursor: JSON.stringify(baseline) },
  });
}

export async function enqueueImapPolling(logger: Logger) {
  const key = "imap-poll:schedule";
  const lockToken = await acquireOwnedLock({ key, processingTtlSeconds: 55 });
  if (!lockToken) return { queued: 0, skipped: true };
  try {
    await prisma.imapSyncSnapshot.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const afterId = await redis.get<string>("imap-poll:schedule-after");
    const eligibility = {
      emailAccount: { account: { provider: "imap", disconnectedAt: null } },
    };
    let accounts = await prisma.imapConnection.findMany({
      where: { ...eligibility, ...(afterId ? { id: { gt: afterId } } : {}) },
      select: { id: true, emailAccountId: true },
      orderBy: { id: "asc" },
      take: ACCOUNT_BATCH,
    });
    if (!accounts.length && afterId)
      accounts = await prisma.imapConnection.findMany({
        where: eligibility,
        select: { id: true, emailAccountId: true },
        orderBy: { id: "asc" },
        take: ACCOUNT_BATCH,
      });
    let queued = 0;
    for (const account of accounts) {
      await enqueueBackgroundJob({
        topic: "imap-poll",
        body: { emailAccountId: account.emailAccountId },
        qstash: {
          queueName: "imap-poll",
          parallelism: 3,
          path: "/api/imap/poll",
          deduplicationId: `imap-poll-${account.emailAccountId}-${Math.floor(Date.now() / 60_000)}`,
        },
        logger,
      });
      await redis.set("imap-poll:schedule-after", account.id);
      queued++;
    }
    return { queued, skipped: false };
  } finally {
    await clearOwnedLock({ key, lockToken });
  }
}

export async function pollImapAccount(emailAccountId: string, logger: Logger) {
  const lease = await acquireImapPollingLease(emailAccountId);
  if (!lease) return { processed: 0, skipped: true };
  const { key, lockToken } = lease;
  let slot: { key: string; lockToken: string } | undefined;
  let authenticationRevision:
    | { accountId: string; updatedAt: Date }
    | undefined;
  try {
    // Queue backends have different concurrency controls; these distributed slots
    // also bound live IMAP sessions on Vercel and the internal HTTP fallback.
    for (let index = 0; index < 3; index++) {
      const slotKey = `imap-poll:connection-slot:${index}`;
      const slotToken = await acquireOwnedLock({
        key: slotKey,
        processingTtlSeconds: POLL_LOCK_SECONDS,
      });
      if (slotToken) {
        slot = { key: slotKey, lockToken: slotToken };
        break;
      }
    }
    if (!slot)
      throw new Error("IMAP polling capacity is busy; retry this account");
    const connection = await prisma.imapConnection.findUnique({
      where: { emailAccountId },
      select: {
        pollCursor: true,
        updatedAt: true,
        emailAccount: {
          select: {
            email: true,
            account: {
              select: { id: true, provider: true, disconnectedAt: true },
            },
          },
        },
      },
    });
    if (
      connection?.emailAccount.account?.provider !== "imap" ||
      connection.emailAccount.account.disconnectedAt
    )
      return { processed: 0, skipped: true };
    const accountId = connection.emailAccount.account.id;
    let connectionRevision = connection.updatedAt;
    authenticationRevision = { accountId, updatedAt: connectionRevision };
    const mailbox = await createImapMailbox(emailAccountId);
    if (!connection.pollCursor) {
      await baselineImapPolling(mailbox);
      return { processed: 0, skipped: false, baseline: true };
    }
    let cursor = cursorSchema.parse(JSON.parse(connection.pollCursor));
    let serializedCursor = connection.pollCursor;
    const deadline = Date.now() + 240_000;
    const account = await getWebhookEmailAccount(
      { id: emailAccountId },
      logger,
    );
    if (!account || account.id !== emailAccountId)
      return { processed: 0, skipped: true };
    const validation = await validateWebhookAccount(account, logger);
    const provider = validation.success
      ? await createEmailProvider({ emailAccountId, provider: "imap", logger })
      : null;
    let changed = false;
    let processed = 0;
    const scan = await mailbox.withConnection(async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        if (!client.mailbox) throw new Error("IMAP inbox selection failed");
        const uidValidity = client.mailbox.uidValidity.toString();
        const maxUid = client.mailbox.uidNext - 1;
        if (cursor.uidValidity !== uidValidity)
          return {
            reset: true as const,
            uidValidity,
            nextUid: maxUid + 1,
            rows: [],
            end: maxUid,
          };
        const end = Math.min(maxUid, cursor.nextUid + POLL_WINDOW - 1);
        const rows =
          client.mailbox.exists && end >= cursor.nextUid
            ? await client.fetchAll(
                `${cursor.nextUid}:${end}`,
                {
                  uid: true,
                  flags: true,
                  internalDate: true,
                  envelope: true,
                  headers: ["references", "in-reply-to"],
                },
                { uid: true },
              )
            : [];
        return {
          reset: false as const,
          uidValidity,
          nextUid: cursor.nextUid,
          rows: rows
            .filter((row) => row.uid >= cursor.nextUid && row.uid <= end)
            .sort((left, right) => left.uid - right.uid),
          end,
        };
      } finally {
        lock.release();
      }
    });
    if (scan.reset) {
      await prisma.imapMessage.updateMany({
        where: {
          emailAccountId,
          folderPath: "INBOX",
          uidValidity: cursor.uidValidity,
        },
        data: { deleted: true },
      });
      await persistCursor({
        version: 1,
        uidValidity: scan.uidValidity,
        nextUid: scan.nextUid,
        receivedAfterMs: Math.floor(Date.now() / 1000) * 1000,
      });
      await publishLocalMailHint(emailAccountId, logger);
      return { processed: 0, skipped: false, reset: true };
    }
    let stopped = false;
    for (const row of scan.rows) {
      if (processed >= MESSAGE_BATCH || Date.now() >= deadline) {
        stopped = true;
        break;
      }
      const flags = [...(row.flags ?? [])].map((flag) => flag.toLowerCase());
      if (flags.includes("\\deleted") || flags.includes("\\draft")) {
        await persistCursor({ ...cursor, nextUid: row.uid + 1 });
        continue;
      }
      const metadata = await mailbox.rememberMessageMetadata(
        "INBOX",
        cursor.uidValidity,
        row,
      );
      const receivedAt = new Date(row.internalDate ?? "").getTime();
      if (!Number.isFinite(receivedAt))
        throw new Error("IMAP returned an invalid incoming message date");
      // COPY/MOVE preserves INTERNALDATE: historical mail placed in INBOX is
      // not a new delivery and must not activate rules on account connection.
      if (receivedAt < cursor.receivedAfterMs) {
        await persistCursor({ ...cursor, nextUid: row.uid + 1 });
        continue;
      }
      if (!validation.success || !provider) {
        await persistCursor({ ...cursor, nextUid: row.uid + 1 });
        changed = true;
        continue;
      }
      const messageKey = `processing-message:${account.email}:${metadata.id}`;
      const messageLock = await acquireOwnedLock({
        key: messageKey,
        processingTtlSeconds: POLL_LOCK_SECONDS,
      });
      if (!messageLock)
        throw new Error(
          "Incoming IMAP message is already being processed; retry this account",
        );
      try {
        let message: ParsedMessage;
        try {
          message = await mailbox.getMessage(metadata.id);
        } catch (error) {
          if (!(error instanceof ImapMessageNotFoundError)) throw error;
          await persistCursor({ ...cursor, nextUid: row.uid + 1 });
          await clearOwnedLock({ key: messageKey, lockToken: messageLock });
          continue;
        }
        if (
          Date.now() >= deadline ||
          (await redis.get<string>(key)) !== lockToken
        )
          throw new Error("IMAP polling lease expired; retry this account");
        const { emailAccount, hasAutomationRules, hasAiAccess } =
          validation.data;
        await processHistoryItem(
          { messageId: message.id, threadId: message.threadId, message },
          {
            provider,
            emailAccount: { ...emailAccount, account: { provider: "imap" } },
            rules: emailAccount.rules,
            hasAutomationRules,
            hasAiAccess,
            logger: logger.with({ messageId: message.id }),
          },
        );
        await persistCursor({ ...cursor, nextUid: row.uid + 1 });
        await markOwnedLockProcessed({
          key: messageKey,
          lockToken: messageLock,
          processedStatus: "true",
          processedTtlSeconds: 300,
        });
        processed++;
        changed = true;
      } catch (error) {
        await clearOwnedLock({ key: messageKey, lockToken: messageLock });
        if (error instanceof ImapUidValidityChangedError)
          throw new Error(
            "IMAP inbox changed during processing; retry the baseline",
          );
        throw error;
      }
    }
    if (!stopped && scan.end >= cursor.nextUid)
      await persistCursor({ ...cursor, nextUid: scan.end + 1 });
    if (changed) await publishLocalMailHint(emailAccountId, logger);
    return { processed, skipped: false, hasMore: stopped };

    async function persistCursor(next: z.infer<typeof cursorSchema>) {
      const encoded = JSON.stringify(next);
      if ((await redis.get<string>(key)) !== lockToken)
        throw new Error("IMAP polling lease expired; retry this account");
      const nextRevision = new Date();
      const result = await prisma.imapConnection.updateMany({
        where: {
          emailAccountId,
          pollCursor: serializedCursor,
          updatedAt: connectionRevision,
          emailAccount: { account: { disconnectedAt: null } },
        },
        data: { pollCursor: encoded, updatedAt: nextRevision },
      });
      if (result.count !== 1)
        throw new Error("IMAP polling connection changed during processing");
      cursor = next;
      serializedCursor = encoded;
      connectionRevision = nextRevision;
      authenticationRevision = { accountId, updatedAt: nextRevision };
    }
  } catch (error) {
    if (error instanceof ImapAuthenticationError && authenticationRevision) {
      await prisma.account.updateMany({
        where: {
          id: authenticationRevision.accountId,
          provider: "imap",
          emailAccount: {
            id: emailAccountId,
            imapConnection: { updatedAt: authenticationRevision.updatedAt },
          },
        },
        data: { disconnectedAt: new Date() },
      });
    }
    throw error;
  } finally {
    if (slot) await clearOwnedLock(slot);
    await clearOwnedLock({ key, lockToken });
  }
}

async function readInboxBaseline(mailbox: ImapMailbox) {
  return mailbox.withConnection(async (client) => {
    const lock = await client.getMailboxLock("INBOX", { readOnly: true });
    try {
      if (!client.mailbox) throw new Error("IMAP inbox selection failed");
      return cursorSchema.parse({
        version: 1,
        uidValidity: client.mailbox.uidValidity.toString(),
        nextUid: client.mailbox.uidNext,
        receivedAfterMs: Math.floor(Date.now() / 1000) * 1000,
      });
    } finally {
      lock.release();
    }
  });
}
