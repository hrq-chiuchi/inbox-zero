"use server";

import { randomUUID } from "node:crypto";
import { after } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { actionClientUser } from "@/utils/actions/safe-action";
import { connectHostingerAccountBody } from "@/utils/actions/imap-account.validation";
import { SafeError } from "@/utils/error";
import { autoJoinOrganization } from "@/utils/auth";
import { ImapMailbox, verifyHostingerCredentials } from "@/utils/imap/client";
import {
  acquireImapPollingLease,
  baselineImapPolling,
} from "@/utils/imap/poll";
import { updateAccountSeats } from "@/utils/premium/seats";
import { INITIAL_MAIL_SPLITS } from "@/utils/split-inbox/initial-splits";
import { clearOwnedLock } from "@/utils/redis/owned-lock";

export const connectHostingerAccountAction = actionClientUser
  .metadata({ name: "connectHostingerAccount" })
  .inputSchema(connectHostingerAccountBody)
  .action(async ({ parsedInput, ctx: { userId, logger } }) => {
    if (!env.EMAIL_ENCRYPT_SECRET?.trim() || !env.EMAIL_ENCRYPT_SALT?.trim()) {
      throw new SafeError(
        "Mailbox encryption is not configured. Contact your administrator before connecting Hostinger.",
      );
    }

    const {
      email,
      password,
      name,
      smtpPort,
      emailAccountId: reconnectId,
    } = parsedInput;
    const [existingMailbox, existingProviderAccount, existingUser] =
      await Promise.all([
        prisma.emailAccount.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          select: {
            id: true,
            userId: true,
            accountId: true,
            account: {
              select: { userId: true, provider: true, providerAccountId: true },
            },
          },
        }),
        prisma.account.findFirst({
          where: {
            provider: "imap",
            providerAccountId: { equals: email, mode: "insensitive" },
          },
          select: { id: true, userId: true },
        }),
        prisma.user.findFirst({
          where: { email: { equals: email, mode: "insensitive" } },
          select: { id: true },
        }),
      ]);

    if (
      (existingMailbox &&
        (existingMailbox.userId !== userId ||
          existingMailbox.account.userId !== userId)) ||
      (existingProviderAccount && existingProviderAccount.userId !== userId) ||
      (existingUser && existingUser.id !== userId)
    ) {
      throw new SafeError("This mailbox is already linked to another user.");
    }

    if (reconnectId) {
      if (
        !existingMailbox ||
        existingMailbox.id !== reconnectId ||
        existingMailbox.account.provider !== "imap" ||
        existingMailbox.account.providerAccountId.toLowerCase() !== email ||
        existingProviderAccount?.id !== existingMailbox.accountId
      ) {
        throw new SafeError(
          "Hostinger account not found. Reconnect only a mailbox you own.",
        );
      }
    } else if (existingMailbox || existingProviderAccount) {
      throw new SafeError(
        "This mailbox is already connected. Use Reconnect in Settings to update its password.",
      );
    }

    try {
      await verifyHostingerCredentials({ email, password, name, smtpPort });
    } catch {
      // Provider failures may contain credentials; never forward the original error.
      throw new SafeError(
        "Could not verify both Hostinger connections. Check your mailbox email and password, then try again.",
      );
    }

    const emailAccountId = reconnectId ?? randomUUID();
    const accountId = existingMailbox?.accountId ?? randomUUID();
    const ownedMailbox = {
      id: emailAccountId,
      userId,
      accountId,
      account: { userId, provider: "imap", providerAccountId: email },
    };

    let pollLease: { key: string; lockToken: string } | null = null;
    if (reconnectId) {
      try {
        pollLease = await acquireImapPollingLease(emailAccountId);
      } catch {
        throw new SafeError(
          "Could not pause mailbox syncing. Try reconnecting again in a moment.",
        );
      }
      if (!pollLease) {
        throw new SafeError(
          "This mailbox is syncing right now. Wait a moment, then reconnect again.",
        );
      }
    }

    try {
      try {
        if (reconnectId) {
          await prisma.$transaction([
            prisma.emailAccount.update({
              where: ownedMailbox,
              data: { ...(name !== undefined ? { name: name || null } : {}) },
              select: { id: true },
            }),
            prisma.imapConnection.update({
              where: { emailAccountId, emailAccount: ownedMailbox },
              data: { password, smtpPort },
              select: { id: true },
            }),
            prisma.account.update({
              where: {
                id: accountId,
                userId,
                provider: "imap",
                providerAccountId: email,
              },
              data: { disconnectedAt: new Date() },
              select: { id: true },
            }),
          ]);
        } else {
          await prisma.$transaction([
            prisma.account.create({
              data: {
                id: accountId,
                userId,
                provider: "imap",
                type: "email",
                providerAccountId: email,
                disconnectedAt: new Date(),
              },
              select: { id: true },
            }),
            prisma.emailAccount.create({
              data: {
                id: emailAccountId,
                userId,
                accountId,
                email,
                name: name || null,
                mailSplits: {
                  create: INITIAL_MAIL_SPLITS.map((split, order) => ({
                    ...split,
                    order,
                  })),
                },
              },
              select: { id: true },
            }),
            // Direct writes are required for the password encryption extension.
            prisma.imapConnection.create({
              data: { emailAccountId, password, smtpPort },
              select: { id: true },
            }),
          ]);
        }
      } catch {
        throw new SafeError(
          "Could not save the Hostinger connection. Refresh your accounts and try again.",
        );
      }

      try {
        await baselineImapPolling(
          new ImapMailbox(emailAccountId, { email, password, smtpPort, name }),
        );
        await prisma.account.update({
          where: {
            id: accountId,
            userId,
            provider: "imap",
            providerAccountId: email,
          },
          data: { disconnectedAt: null },
          select: { id: true },
        });
      } catch {
        throw new SafeError(
          "Your verified mailbox was saved, but syncing could not start. Reconnect it in Settings to try again.",
        );
      }
    } finally {
      if (pollLease) {
        await clearOwnedLock(pollLease).catch(() => {
          logger.error("Could not release Hostinger reconnect polling lease", {
            emailAccountId,
          });
        });
      }
    }

    after(async () => {
      if (env.AUTO_JOIN_ORGANIZATION_ENABLED) {
        await autoJoinOrganization(emailAccountId).catch(() => {
          logger.error(
            "Could not auto-join organization for Hostinger account",
            { emailAccountId },
          );
        });
      }
      await updateAccountSeats({ userId }).catch(() => {
        logger.error(
          "Could not update account seats after Hostinger connection",
        );
      });
    });

    return { emailAccountId };
  });
