import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SearchObject } from "imapflow";
import type Mail from "nodemailer/lib/mailer";
import prisma from "@/utils/prisma";
import type { ImapLabel } from "@/generated/prisma/client";
import type { ParsedMessage } from "@/utils/types";
import type {
  EmailProvider,
  EmailThread,
  EmailLabel,
  EmailLabelUpdate,
  GetThreadOptions,
} from "@/utils/email/types";
import type { SendEmailBody } from "@/utils/types/mail";
import { toMailerAttachments } from "@/utils/types/mail";
import { inboxZeroLabels, type InboxZeroLabel } from "@/utils/label";
import type {
  OutlookFolder,
  OutlookSystemFolder,
} from "@/utils/outlook/folders";
import {
  type ImapMailbox,
  ImapCapabilityError,
  ImapMessageNotFoundError,
} from "@/utils/imap/client";
import { SPECIAL_ROLES, parseSource } from "@/utils/imap/message";
import {
  compileImapQuery,
  compileThreadConditions,
  matchesMailboxSearch,
  matchesSender,
  messageAddresses,
  receivedTime,
} from "@/utils/imap/query";
import {
  composeImapMail,
  draftMailOptions,
  replyMailOptions,
  sendImapMail,
} from "@/utils/imap/mail";
import { getImapMailboxSyncPage, syncImapLocalMail } from "@/utils/imap/sync";
import { InvalidMailboxSyncCursorError } from "@/utils/email/mailbox-sync";
import { normalizeContactCandidates } from "@/utils/email/contact";
import { extractSignatureFromHtml } from "@/utils/email/signature-extraction";
import { createScopedLogger } from "@/utils/logger";
import { handlePreviousDraftDeletion } from "@/utils/ai/choose-rule/draft-management";

type CustomLabel = ImapLabel;
type PageOptions = { maxResults?: number; pageToken?: string };
const providerSnapshotSchema = z.object({
  ids: z.array(z.string()).max(100_000),
});
const labelColorSchema = z
  .object({
    backgroundColor: z.string().nullish(),
    textColor: z.string().nullish(),
  })
  .nullish();
const logger = createScopedLogger("email/imap");

export class ImapProvider implements EmailProvider {
  readonly name = "imap" as const;
  readonly localMailSyncStrategy = "folder-delta" as const;
  readonly mailbox: ImapMailbox;

  constructor(mailbox: ImapMailbox) {
    this.mailbox = mailbox;
  }
  toJSON() {
    return { name: this.name, type: "Hostinger IMAP" };
  }
  getAccessToken(): string {
    throw new ImapCapabilityError("OAuth access tokens");
  }
  getMailboxSyncPage(
    options: Parameters<EmailProvider["getMailboxSyncPage"]>[0],
  ) {
    return getImapMailboxSyncPage(this.mailbox, options);
  }
  syncLocalMail(
    request: Parameters<EmailProvider["syncLocalMail"]>[0],
    context: { emailAccountId: string },
  ) {
    return syncImapLocalMail(this.mailbox, request, context);
  }

  private async allMessages(
    options: {
      folderId?: string;
      search?: SearchObject;
      includeDrafts?: boolean;
    } = {},
  ): Promise<ParsedMessage[]> {
    const messages: ParsedMessage[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.mailbox.fetchMessages({
        ...options,
        maxResults: 1000,
        pageToken,
      });
      messages.push(...page.messages);
      pageToken = page.nextPageToken;
    } while (pageToken);
    return messages.sort((a, b) => receivedTime(b) - receivedTime(a));
  }

  private async pageIds(
    scope: unknown,
    options: PageOptions,
    collect: () => Promise<string[]>,
  ): Promise<{ ids: string[]; nextPageToken?: string }> {
    const limit = Math.min(Math.max(options.maxResults ?? 50, 1), 1000);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(scope))
      .digest("hex");
    const folderPath = `provider:${fingerprint}`;
    let ids: string[];
    let snapshotId: string;
    let offset = 0;
    if (options.pageToken) {
      const token = /^imap-result:([a-z0-9]+):(\d+)$/.exec(options.pageToken);
      if (!token) throw new InvalidMailboxSyncCursorError();
      const snapshot = await prisma.imapSyncSnapshot.findFirst({
        where: {
          id: token[1],
          emailAccountId: this.mailbox.emailAccountId,
          folderPath,
          expiresAt: { gt: new Date() },
        },
      });
      if (!snapshot) throw new InvalidMailboxSyncCursorError();
      const state = providerSnapshotSchema.safeParse(snapshot.state);
      if (!state.success) throw new InvalidMailboxSyncCursorError();
      ids = state.data.ids;
      offset = Number(token[2]);
      snapshotId = snapshot.id;
      if (!Number.isSafeInteger(offset) || offset > ids.length)
        throw new InvalidMailboxSyncCursorError();
    } else {
      ids = await collect();
      const snapshot = await prisma.imapSyncSnapshot.create({
        data: {
          emailAccountId: this.mailbox.emailAccountId,
          folderPath,
          state: { ids },
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      snapshotId = snapshot.id;
    }
    const page = ids.slice(offset, offset + limit);
    offset += page.length;
    return {
      ids: page,
      nextPageToken:
        offset < ids.length ? `imap-result:${snapshotId}:${offset}` : undefined,
    };
  }

  private async filteredPage(
    scope: unknown,
    options: PageOptions,
    predicate: (message: ParsedMessage) => boolean,
    source: {
      folderId?: string;
      search?: SearchObject;
      includeDrafts?: boolean;
    } = {},
  ) {
    const page = await this.pageIds(scope, options, async () =>
      (await this.allMessages(source))
        .filter(predicate)
        .map((message) => message.id),
    );
    const messages: ParsedMessage[] = [];
    for (const id of page.ids) {
      try {
        messages.push(await this.getMessage(id));
      } catch (error) {
        if (!(error instanceof ImapMessageNotFoundError)) throw error;
      }
    }
    return { messages, nextPageToken: page.nextPageToken };
  }

  getMessage(messageId: string) {
    return this.mailbox.getMessage(messageId);
  }
  async getMessagesBatch(messageIds: string[]) {
    return Promise.all(messageIds.map((id) => this.getMessage(id)));
  }
  async getOriginalMessage(originalMessageId: string | undefined) {
    return originalMessageId ? this.getMessage(originalMessageId) : null;
  }
  getPreviousConversationMessages(messageIds: string[]) {
    return this.getMessagesBatch(messageIds);
  }
  async getMessageByRfc822MessageId(rfc822MessageId: string) {
    const normalized = rfc822MessageId.startsWith("<")
      ? rfc822MessageId
      : `<${rfc822MessageId}>`;
    const messages = await this.allMessages({
      search: { header: { "message-id": normalized } },
      includeDrafts: true,
    });
    return (
      messages.find(
        (message) => message.headers["message-id"] === normalized,
      ) ?? null
    );
  }

  async getMessagesWithPagination(
    options: Parameters<EmailProvider["getMessagesWithPagination"]>[0],
  ) {
    const context = await this.queryContext();
    const predicate = compileImapQuery(options.query ?? "", context);
    const folderId =
      options.folderId ??
      (options.inboxOnly
        ? await this.mailbox.getOrCreateSpecialFolder("INBOX")
        : undefined);
    return this.filteredPage(
      {
        operation: "messages",
        ...options,
        pageToken: undefined,
        maxResults: undefined,
      },
      options,
      (message) =>
        predicate(message) &&
        (!options.inboxOnly || !!message.labelIds?.includes("INBOX")) &&
        (!options.unreadOnly || !!message.labelIds?.includes("UNREAD")) &&
        (!options.after || receivedTime(message) > options.after.getTime()) &&
        (!options.before || receivedTime(message) < options.before.getTime()),
      {
        folderId,
        includeDrafts: options.includeDrafts,
        search: {
          seen: options.unreadOnly ? false : undefined,
          since: options.after,
          before: options.before
            ? new Date(options.before.getTime() + 86_400_000)
            : undefined,
        },
      },
    );
  }
  async getMessagesFromSender(
    options: Parameters<EmailProvider["getMessagesFromSender"]>[0],
  ) {
    return this.filteredPage(
      {
        operation: "sender",
        ...options,
        pageToken: undefined,
        maxResults: undefined,
      },
      options,
      (message) =>
        matchesSender(message, options.senderEmail) &&
        (!options.before || receivedTime(message) < options.before.getTime()) &&
        (!options.after || receivedTime(message) > options.after.getTime()),
      {
        search: {
          from: options.senderEmail,
          since: options.after,
          before: options.before
            ? new Date(options.before.getTime() + 86_400_000)
            : undefined,
        },
      },
    );
  }
  async getMessagesWithAttachments(options: PageOptions) {
    return this.filteredPage(
      { operation: "attachments" },
      options,
      (message) => !!message.hasAttachment,
    );
  }
  async searchMessages(
    options: Parameters<EmailProvider["searchMessages"]>[0],
  ) {
    const context = await this.queryContext();
    const predicate = compileImapQuery(options.query, context);
    if (
      options.labelName &&
      !Object.values(context.labelNames).includes(options.labelName)
    )
      throw new Error("Unknown mailbox label.");
    const labelId = options.labelName
      ? Object.entries(context.labelNames).find(
          ([, name]) => name === options.labelName,
        )?.[0]
      : undefined;
    const source = await this.nativeSource({
      from: options.fromEmail,
      read: options.readState
        ? options.readState === "read"
        : options.mailboxSearch?.read,
      starred: options.mailboxSearch?.starred,
      labelIds: [...(options.labelIds ?? []), ...(labelId ? [labelId] : [])],
      role: options.folder ?? options.mailboxSearch?.mailbox,
      includeDrafts: true,
    });
    return this.filteredPage(
      {
        operation: "search",
        ...options,
        pageToken: undefined,
        maxResults: undefined,
      },
      options,
      (message) => {
        const labels = message.labelIds ?? [];
        return (
          predicate(message) &&
          (!options.fromEmail || matchesSender(message, options.fromEmail)) &&
          (!options.readState ||
            labels.includes("UNREAD") === (options.readState === "unread")) &&
          (!labelId || labels.includes(labelId)) &&
          (!options.labelIds?.length ||
            options.labelIds.every((label) => labels.includes(label))) &&
          (!options.folder ||
            labels.includes(options.folder === "spam" ? "SPAM" : "TRASH")) &&
          (options.includeSpamTrash ||
            options.folder ||
            options.mailboxSearch?.mailbox === "spam" ||
            options.mailboxSearch?.mailbox === "trash" ||
            (!labels.includes("SPAM") && !labels.includes("TRASH"))) &&
          (!options.mailboxSearch ||
            matchesMailboxSearch(message, options.mailboxSearch))
        );
      },
      source,
    );
  }

  async getThread(
    threadId: string,
    options: GetThreadOptions = {},
  ): Promise<EmailThread> {
    options.signal?.throwIfAborted();
    return this.readThread(threadId, options);
  }

  private async readThread(
    threadId: string,
    options: GetThreadOptions = {},
  ): Promise<EmailThread> {
    const mappings = await prisma.imapMessage.findMany({
      where: {
        emailAccountId: this.mailbox.emailAccountId,
        threadId,
        deleted: false,
      },
      orderBy: { internalDate: "asc" },
    });
    const messages: ParsedMessage[] = [];
    for (const mapping of mappings) {
      options.signal?.throwIfAborted();
      try {
        const message = await this.getMessage(mapping.id);
        if (options.includeDrafts || !message.labelIds?.includes("DRAFT"))
          messages.push(message);
      } catch (error) {
        if (!(error instanceof ImapMessageNotFoundError)) throw error;
      }
    }
    if (!messages.length) throw new ImapMessageNotFoundError();
    return {
      id: threadId,
      messages,
      snippet: messages[messages.length - 1].snippet,
    };
  }
  async getThreadMessages(threadId: string) {
    return (await this.getThread(threadId)).messages;
  }
  async getThreadMessagesInInbox(threadId: string) {
    return (await this.getThreadMessages(threadId)).filter((message) =>
      message.labelIds?.includes("INBOX"),
    );
  }
  async getLatestMessageInThread(threadId: string) {
    const messages = await this.getThreadMessages(threadId);
    return messages[messages.length - 1] ?? null;
  }
  async getLatestMessageFromThreadSnapshot(
    thread: Pick<EmailThread, "id" | "messages">,
  ) {
    return this.getLatestMessageInThread(thread.id);
  }
  async getThreads(folderId?: string) {
    return groupThreads(await this.allMessages({ folderId }));
  }
  async getThreadsWithLabel(options: { labelId: string; maxResults?: number }) {
    return (
      await this.getThreadsWithQuery({
        query: { labelId: options.labelId },
        maxResults: options.maxResults,
      })
    ).threads;
  }
  async getThreadsFromSenderWithSubject(sender: string, limit: number) {
    return (
      await this.getThreadsWithQuery({
        query: { fromEmail: sender },
        maxResults: limit,
      })
    ).threads.map((thread) => ({
      id: thread.id,
      snippet: thread.snippet,
      subject: thread.messages[thread.messages.length - 1]?.subject ?? "",
    }));
  }
  async getThreadsWithParticipant(options: {
    participantEmail: string;
    maxThreads?: number;
  }) {
    const participant = options.participantEmail.toLowerCase();
    const messages = await this.allMessages();
    const ids = new Set(
      messages
        .filter((message) =>
          [message.headers.from, message.headers.to, message.headers.cc].some(
            (header) => messageAddresses(header).includes(participant),
          ),
        )
        .map((message) => message.threadId),
    );
    return groupThreads(
      messages.filter((message) => ids.has(message.threadId)),
    ).slice(0, options.maxThreads ?? 50);
  }
  async getThreadsWithQuery(
    options: Parameters<EmailProvider["getThreadsWithQuery"]>[0],
  ) {
    const query = options.query ?? {};
    const predicate = compileThreadConditions(query, await this.queryContext());
    const page = await this.pageIds(
      { operation: "threads", query: { ...query, nextPageToken: undefined } },
      {
        maxResults: options.maxResults ?? query.limit ?? undefined,
        pageToken: options.pageToken ?? query.nextPageToken ?? undefined,
      },
      async () => {
        const source = await this.nativeSource({
          folderId: query.folderId ?? undefined,
          from: query.fromEmail ?? undefined,
          after: query.after ?? undefined,
          before: query.before ?? undefined,
          read: query.isUnread || query.type === "unread" ? false : undefined,
          starred: query.type === "starred" ? true : undefined,
          labelIds: [
            ...(query.labelIds ?? []),
            ...(query.labelId ? [query.labelId] : []),
          ],
          role:
            query.type === "unread" || query.excludeSplits?.length
              ? "inbox"
              : (query.type ?? undefined),
          includeDrafts: query.type === "draft" || query.type === "drafts",
        });
        const messages = await this.allMessages(source);
        return [
          ...new Set(
            messages.filter(predicate).map((message) => message.threadId),
          ),
        ];
      },
    );
    const threads: EmailThread[] = [];
    for (const id of page.ids) {
      try {
        threads.push(
          await this.readThread(id, {
            includeDrafts: query.type === "draft" || query.type === "drafts",
          }),
        );
      } catch (error) {
        if (!(error instanceof ImapMessageNotFoundError)) throw error;
      }
    }
    return { threads, nextPageToken: page.nextPageToken };
  }
  async searchThreads(options: Parameters<EmailProvider["searchThreads"]>[0]) {
    const context = await this.queryContext();
    const predicate = compileImapQuery(options.query, context);
    const page = await this.pageIds(
      {
        operation: "searchThreads",
        ...options,
        pageToken: undefined,
        maxResults: undefined,
        messageFormat: undefined,
      },
      options,
      async () => {
        const messages = await this.allMessages(
          await this.nativeSource({
            role: options.folder,
            labelIds: options.labelIds,
            includeDrafts: true,
          }),
        );
        return [
          ...new Set(
            messages
              .filter(
                (message) =>
                  predicate(message) &&
                  (!options.labelIds?.length ||
                    options.labelIds.every((label) =>
                      message.labelIds?.includes(label),
                    )) &&
                  (!options.folder ||
                    message.labelIds?.includes(
                      options.folder === "spam" ? "SPAM" : "TRASH",
                    )) &&
                  (options.includeSpamTrash ||
                    options.folder ||
                    (!message.labelIds?.includes("SPAM") &&
                      !message.labelIds?.includes("TRASH"))),
              )
              .map((message) => message.threadId),
          ),
        ];
      },
    );
    return {
      threads: await Promise.all(
        page.ids.map((id) => this.readThread(id, { includeDrafts: true })),
      ),
      nextPageToken: page.nextPageToken,
    };
  }

  async getInboxMessages(maxResults = 50) {
    return (
      await this.mailbox.fetchMessages({
        folderId: await this.mailbox.getOrCreateSpecialFolder("INBOX"),
        maxResults,
      })
    ).messages;
  }
  async getSentMessages(maxResults = 50) {
    return (
      await this.mailbox.fetchMessages({
        folderId: await this.mailbox.getOrCreateSpecialFolder("SENT"),
        maxResults,
      })
    ).messages;
  }
  async getSentMessageIds(
    options: Parameters<EmailProvider["getSentMessageIds"]>[0],
  ) {
    const result = await this.getMessagesWithPagination({
      ...options,
      folderId: await this.mailbox.getOrCreateSpecialFolder("SENT"),
    });
    return {
      messages: result.messages.map((message) => ({
        id: message.id,
        threadId: message.threadId,
      })),
      nextPageToken: result.nextPageToken,
    };
  }
  async getSentThreadsExcluding(
    options: Parameters<EmailProvider["getSentThreadsExcluding"]>[0],
  ) {
    const messages = await this.allMessages({
      folderId: await this.mailbox.getOrCreateSpecialFolder("SENT"),
    });
    const excluded = (value: string, addresses: string[] | undefined) =>
      addresses?.some((address) =>
        messageAddresses(value).includes(address.toLowerCase()),
      ) ?? false;
    return groupThreads(
      messages.filter(
        (message) =>
          !excluded(message.headers.to, options.excludeToEmails) &&
          !excluded(message.headers.from, options.excludeFromEmails),
      ),
    ).slice(0, options.maxResults ?? 50);
  }
  async getInboxStats() {
    const path = await this.mailbox.getOrCreateSpecialFolder("INBOX");
    const folder = (await this.mailbox.listFolders()).find(
      (item) => item.id === path,
    );
    if (!folder) throw new Error("Inbox folder is unavailable.");
    return { total: folder.total, unread: folder.unread };
  }
  async checkIfReplySent(senderEmail: string) {
    return (
      await this.allMessages({
        folderId: await this.mailbox.getOrCreateSpecialFolder("SENT"),
        search: { to: senderEmail },
      })
    ).some((message) =>
      messageAddresses(message.headers.to).includes(senderEmail.toLowerCase()),
    );
  }
  async countReceivedMessages(senderEmail: string, threshold: number) {
    return Math.min(
      (await this.allMessages({ search: { from: senderEmail } })).filter(
        (message) =>
          matchesSender(message, senderEmail) && !this.isSentMessage(message),
      ).length,
      threshold,
    );
  }
  async hasPreviousCommunicationsWithSenderOrDomain(options: {
    from: string;
    date: Date;
    messageId: string;
  }) {
    const sender = messageAddresses(options.from)[0];
    if (!sender) throw new Error("Invalid sender address.");
    const domain = `@${sender.split("@")[1]}`;
    return (
      await this.allMessages({
        search: { before: new Date(options.date.getTime() + 86_400_000) },
      })
    ).some(
      (message) =>
        message.id !== options.messageId &&
        receivedTime(message) < options.date.getTime() &&
        [message.headers.from, message.headers.to].some((header) =>
          messageAddresses(header).some(
            (address) => address === sender || address.endsWith(domain),
          ),
        ),
    );
  }
  isReplyInThread(message: ParsedMessage) {
    return !!message.headers["in-reply-to"] || !!message.headers.references;
  }
  isSentMessage(message: ParsedMessage) {
    return !!message.labelIds?.includes("SENT");
  }

  async getFolders(): Promise<OutlookFolder[]> {
    const folders = await this.mailbox.listFolders();
    return folders.map((folder) => ({
      id: folder.id,
      displayName: folder.name,
      childFolders: [],
      childFolderCount: 0,
      totalItemCount: folder.total,
      unreadItemCount: folder.unread,
      systemType:
        (Object.entries(SPECIAL_ROLES).find(
          ([, use]) => use === folder.specialUse,
        )?.[0] as OutlookSystemFolder | undefined) ??
        (folder.id.toUpperCase() === "INBOX" ? "INBOX" : undefined),
    }));
  }
  async getFolderCounts() {
    return (await this.getFolders()).map((folder) => ({
      id: folder.id,
      name: folder.displayName,
      total: folder.totalItemCount ?? 0,
      unread: folder.unreadItemCount ?? 0,
      systemType: folder.systemType,
    }));
  }
  async getOrCreateFolderIdByName(folderName: string) {
    if (!folderName.trim() || /[\r\n\0]/.test(folderName))
      throw new Error("Invalid mailbox folder name.");
    const folder = (await this.mailbox.listFolders()).find(
      (item) => item.id === folderName || item.name === folderName,
    );
    if (folder) return folder.id;
    return this.mailbox.withConnection(
      async (client) => (await client.mailboxCreate(folderName)).path,
    );
  }
  async renameFolder(folderId: string, name: string) {
    if (!name.trim() || /[\r\n\0]/.test(name))
      throw new Error("Invalid mailbox folder name.");
    const folders = await this.mailbox.listFolders();
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) throw new Error("Unknown mailbox folder.");
    await this.mailbox.withConnection(async (client) => {
      await client.mailboxRename(folderId, name);
    });
    for (const item of folders.filter(
      (item) =>
        item.id === folderId ||
        item.id.startsWith(`${folderId}${folder.delimiter}`),
    )) {
      await prisma.imapMessage.updateMany({
        where: {
          emailAccountId: this.mailbox.emailAccountId,
          folderPath: item.id,
        },
        data: { folderPath: `${name}${item.id.slice(folderId.length)}` },
      });
    }
  }
  async deleteFolder(folderId: string) {
    const folders = await this.mailbox.listFolders();
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) throw new Error("Unknown mailbox folder.");
    if (folder.specialUse || folder.id.toUpperCase() === "INBOX")
      throw new Error("System mailbox folders cannot be deleted.");
    if (
      folders.some((item) =>
        item.id.startsWith(`${folderId}${folder.delimiter}`),
      )
    )
      throw new Error("Delete child folders before deleting their parent.");
    await this.mailbox.withConnection(async (client) => {
      await client.mailboxDelete(folderId);
    });
    await prisma.imapMessage.updateMany({
      where: {
        emailAccountId: this.mailbox.emailAccountId,
        folderPath: folderId,
      },
      data: { deleted: true },
    });
  }

  async getLabels(): Promise<EmailLabel[]> {
    const folders = await this.getFolders();
    const custom = await prisma.imapLabel.findMany({
      where: { emailAccountId: this.mailbox.emailAccountId },
      orderBy: { name: "asc" },
    });
    return [
      ...folders.map((folder) => ({
        id: folder.id,
        name: folder.displayName,
        type: "system",
        threadsTotal: folder.totalItemCount,
        threadsUnread: folder.unreadItemCount,
      })),
      ...custom.map(toEmailLabel),
    ];
  }
  async getLabelById(labelId: string): Promise<EmailLabel | null> {
    if (labelId === "UNREAD" || Object.hasOwn(SPECIAL_ROLES, labelId)) {
      const folders = await this.mailbox.listFolders();
      if (labelId === "UNREAD") {
        const unread = folders.reduce(
          (total, folder) => total + folder.unread,
          0,
        );
        return {
          id: labelId,
          name: "Unread",
          type: "system",
          threadsTotal: unread,
          threadsUnread: unread,
        };
      }
      const specialUse = SPECIAL_ROLES[labelId as keyof typeof SPECIAL_ROLES];
      const folder = folders.find((item) => item.specialUse === specialUse);
      return folder
        ? {
            id: labelId,
            name: folder.name,
            type: "system",
            threadsTotal: folder.total,
            threadsUnread: folder.unread,
          }
        : null;
    }
    return (
      (await this.getLabels()).find((label) => label.id === labelId) ?? null
    );
  }
  async getLabelByName(name: string) {
    return (
      (await this.getLabels()).find((label) => label.name === name) ?? null
    );
  }
  async createLabel(name: string) {
    if (!name.trim() || /[\r\n\0]/.test(name))
      throw new Error("Invalid mailbox label name.");
    const existing = await prisma.imapLabel.findFirst({
      where: { emailAccountId: this.mailbox.emailAccountId, name },
    });
    if (existing) return toEmailLabel(existing);
    await this.mailbox.withConnection(async (client) => {
      const lock = await client.getMailboxLock("INBOX");
      try {
        if (
          client.mailbox?.permanentFlags &&
          !client.mailbox.permanentFlags.has("\\*")
        )
          throw new ImapCapabilityError("Custom keyword labels");
      } finally {
        lock.release();
      }
    });
    return toEmailLabel(
      await prisma.imapLabel.create({
        data: {
          emailAccountId: this.mailbox.emailAccountId,
          name,
          keyword: `iz-${randomUUID().replaceAll("-", "")}`,
        },
      }),
    );
  }
  async getOrCreateInboxZeroLabel(key: InboxZeroLabel) {
    return this.createLabel(inboxZeroLabels[key].name);
  }
  private async customLabel(labelId: string) {
    const label = await prisma.imapLabel.findFirst({
      where: { id: labelId, emailAccountId: this.mailbox.emailAccountId },
    });
    if (!label) throw new Error("Unknown custom mailbox label.");
    return label;
  }
  async labelMessage(options: {
    messageId: string;
    labelId: string;
    labelName: string | null;
  }) {
    const label = await this.customLabel(options.labelId);
    await this.mailbox.setFlags([options.messageId], [label.keyword], true);
    return { actualLabelId: label.id };
  }
  async removeThreadLabel(threadId: string, labelId: string) {
    const label = await this.customLabel(labelId);
    await this.mailbox.setFlags(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
      [label.keyword],
      false,
    );
  }
  async removeThreadLabels(threadId: string, labelIds: string[]) {
    const labels = await Promise.all(
      labelIds.map((id) => this.customLabel(id)),
    );
    await this.mailbox.setFlags(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
      labels.map((label) => label.keyword),
      false,
    );
  }
  async deleteLabel(labelId: string) {
    const label = await this.customLabel(labelId);
    const messages = await this.allMessages({
      search: { keyword: label.keyword },
      includeDrafts: true,
    });
    await this.mailbox.setFlags(
      messages.map((message) => message.id),
      [label.keyword],
      false,
    );
    await prisma.imapLabel.deleteMany({
      where: { id: label.id, emailAccountId: this.mailbox.emailAccountId },
    });
  }
  async updateLabel(labelId: string, update: EmailLabelUpdate) {
    await this.customLabel(labelId);
    if (update.name && (!update.name.trim() || /[\r\n\0]/.test(update.name)))
      throw new Error("Invalid mailbox label name.");
    await prisma.imapLabel.updateMany({
      where: { id: labelId, emailAccountId: this.mailbox.emailAccountId },
      data: {
        name: update.name,
        color: update.color,
        labelListVisibility: update.labelListVisibility,
        messageListVisibility: update.messageListVisibility,
      },
    });
  }
  private async queryContext() {
    return {
      labelNames: Object.fromEntries(
        (await this.getLabels()).map((label) => [label.id, label.name]),
      ),
      now: new Date(),
    };
  }

  async archiveMessage(messageId: string) {
    await this.archiveMessages([messageId]);
  }
  async archiveMessages(messageIds: string[], labelId?: string) {
    if (labelId)
      for (const messageId of messageIds)
        await this.labelMessage({ messageId, labelId, labelName: null });
    await this.mailbox.moveMessages(
      messageIds,
      await this.mailbox.getOrCreateSpecialFolder("ARCHIVE"),
    );
  }
  async archiveThread(threadId: string, _ownerEmail: string) {
    await this.archiveMessages(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
    );
  }
  async archiveThreadWithLabel(
    threadId: string,
    _ownerEmail: string,
    labelId?: string,
  ) {
    await this.archiveMessages(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
      labelId,
    );
  }
  async bulkArchiveThreads(
    threads: Parameters<EmailProvider["bulkArchiveThreads"]>[0],
    _ownerEmail: string,
  ) {
    const succeededThreadIds: string[] = [];
    const failedThreadIds: string[] = [];
    for (const thread of threads) {
      try {
        await this.archiveMessages(thread.messageIds);
        succeededThreadIds.push(thread.threadId);
      } catch {
        failedThreadIds.push(thread.threadId);
      }
    }
    return { succeededThreadIds, failedThreadIds };
  }
  async bulkArchiveFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    emailAccountId: string,
  ) {
    if (emailAccountId !== this.mailbox.emailAccountId)
      throw new Error("Mailbox account mismatch.");
    const messages = await this.allMessages({
      folderId: await this.mailbox.getOrCreateSpecialFolder("INBOX"),
    });
    await this.archiveMessages(
      messages
        .filter((message) =>
          fromEmails.some((sender) => matchesSender(message, sender)),
        )
        .map((message) => message.id),
    );
  }
  async bulkTrashFromSenders(
    fromEmails: string[],
    _ownerEmail: string,
    emailAccountId: string,
  ) {
    if (emailAccountId !== this.mailbox.emailAccountId)
      throw new Error("Mailbox account mismatch.");
    const messages = await this.allMessages();
    await this.trashMessages(
      messages
        .filter((message) =>
          fromEmails.some((sender) => matchesSender(message, sender)),
        )
        .map((message) => message.id),
    );
  }
  async trashMessages(messageIds: string[]) {
    await this.mailbox.moveMessages(
      messageIds,
      await this.mailbox.getOrCreateSpecialFolder("TRASH"),
    );
  }
  async trashThread(
    threadId: string,
    _ownerEmail: string,
    _actionSource: "user" | "automation",
  ) {
    await this.trashMessages(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
    );
  }
  async unarchiveMessages(messageIds: string[]) {
    await this.mailbox.moveMessages(
      messageIds,
      await this.mailbox.getOrCreateSpecialFolder("INBOX"),
    );
  }
  async unarchiveThread(threadId: string) {
    await this.unarchiveMessages(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
    );
  }
  async untrashMessages(messageIds: string[]) {
    await this.unarchiveMessages(messageIds);
  }
  async untrashThread(threadId: string) {
    await this.unarchiveThread(threadId);
  }
  async markMessagesReadState(messageIds: string[], read: boolean) {
    await this.mailbox.setFlags(messageIds, ["\\Seen"], read);
  }
  async markMessagesStarredState(messageIds: string[], starred: boolean) {
    await this.mailbox.setFlags(messageIds, ["\\Flagged"], starred);
  }
  private async nativeSource(options: {
    folderId?: string;
    from?: string;
    after?: Date;
    before?: Date;
    read?: boolean;
    starred?: boolean;
    labelIds?: string[];
    role?: string;
    includeDrafts?: boolean;
  }) {
    const search: SearchObject = {
      from: options.from,
      seen: options.read,
      flagged: options.starred,
      since: options.after,
      before: options.before
        ? new Date(options.before.getTime() + 86_400_000)
        : undefined,
    };
    let folderId = options.folderId;
    const roles: Record<string, keyof typeof SPECIAL_ROLES> = {
      inbox: "INBOX",
      sent: "SENT",
      draft: "DRAFT",
      drafts: "DRAFT",
      archive: "ARCHIVE",
      trash: "TRASH",
      spam: "SPAM",
    };
    if (!folderId && options.role && roles[options.role])
      folderId = await this.mailbox.getOrCreateSpecialFolder(
        roles[options.role],
      );
    const folders = options.labelIds?.length
      ? await this.mailbox.listFolders()
      : [];
    const labels = options.labelIds?.length
      ? await prisma.imapLabel.findMany({
          where: {
            emailAccountId: this.mailbox.emailAccountId,
            id: { in: options.labelIds },
          },
        })
      : [];
    for (const labelId of options.labelIds ?? []) {
      if (labelId === "UNREAD") search.seen = false;
      else if (labelId === "STARRED") search.flagged = true;
      else if (roles[labelId.toLowerCase()])
        folderId ??= await this.mailbox.getOrCreateSpecialFolder(
          roles[labelId.toLowerCase()],
        );
      else if (folders.some((folder) => folder.id === labelId))
        folderId ??= labelId;
      else {
        const label = labels.find((label) => label.id === labelId);
        if (label && !search.keyword) search.keyword = label.keyword;
      }
    }
    return { folderId, search, includeDrafts: options.includeDrafts };
  }
  async starMessage(messageId: string) {
    await this.markMessagesStarredState([messageId], true);
  }
  async markRead(threadId: string) {
    await this.markReadThread(threadId, true);
  }
  async markReadThread(threadId: string, read: boolean) {
    await this.markMessagesReadState(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
      read,
    );
  }
  async markSpam(threadId: string) {
    await this.mailbox.moveMessages(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
      await this.mailbox.getOrCreateSpecialFolder("SPAM"),
    );
  }
  async markNotSpam(threadId: string) {
    await this.unarchiveThread(threadId);
  }
  async moveThreadToFolder(
    threadId: string,
    _ownerEmail: string,
    folderName: string,
  ) {
    await this.mailbox.moveMessages(
      (await this.getThreadMessages(threadId)).map((message) => message.id),
      await this.getOrCreateFolderIdByName(folderName),
    );
  }

  async createDraft(params: Parameters<EmailProvider["createDraft"]>[0]) {
    const reply = params.replyToMessageId
      ? replyMailOptions(await this.getMessage(params.replyToMessageId))
      : {};
    const draft = await this.appendDraft({
      to: params.to,
      subject: params.subject,
      html: params.messageHtml,
      ...reply,
    });
    return { id: draft.id };
  }
  private async appendDraft(options: Mail.Options) {
    const composed = await composeImapMail(this.mailbox, options);
    return this.mailbox.appendMessage(
      await this.mailbox.getOrCreateSpecialFolder("DRAFT"),
      composed.storedRaw,
      ["\\Draft"],
    );
  }
  async getDraft(draftId: string) {
    try {
      const message = await this.getMessage(draftId);
      return message.labelIds?.includes("DRAFT") ? message : null;
    } catch (error) {
      if (error instanceof ImapMessageNotFoundError) return null;
      throw error;
    }
  }
  async getDraftReferenceForMessage(messageId: string) {
    const draft = await this.getDraft(messageId);
    if (!draft) return null;
    const mapping = await this.mailbox.resolveMessage(messageId);
    return { id: draft.id, version: `${mapping.uidValidity}:${mapping.uid}` };
  }
  async getDrafts(options: { maxResults?: number } = {}) {
    return (
      await this.mailbox.fetchMessages({
        folderId: await this.mailbox.getOrCreateSpecialFolder("DRAFT"),
        includeDrafts: true,
        maxResults: options.maxResults,
      })
    ).messages;
  }
  async deleteDraft(draftId: string, version?: string) {
    if (!(await this.getDraft(draftId))) return false;
    const mapping = await this.mailbox.resolveMessage(draftId);
    if (version && version !== `${mapping.uidValidity}:${mapping.uid}`)
      throw new Error(
        "The draft changed since it was opened. Refresh before deleting it.",
      );
    await this.mailbox.removeMessages([draftId]);
    return true;
  }
  async updateDraft(
    draftId: string,
    params: Parameters<EmailProvider["updateDraft"]>[1],
  ) {
    if (!(await this.getDraft(draftId))) throw new ImapMessageNotFoundError();
    const oldMapping = await this.mailbox.resolveMessage(draftId);
    const old = await draftMailOptions(this.mailbox, draftId);
    const replacement = await this.appendDraft({
      ...old,
      html: params.messageHtml ?? old.html,
      text: params.messageHtml !== undefined ? undefined : old.text,
      subject: params.subject ?? old.subject,
      to: params.to ?? old.to,
      cc: params.cc ?? old.cc,
      bcc: params.bcc ?? old.bcc,
      attachments:
        params.attachments !== undefined
          ? toMailerAttachments(params.attachments)
          : old.attachments,
    });
    const newMapping = await this.mailbox.resolveMessage(replacement.id);
    await this.mailbox.removeMessages([draftId]);
    // APPEND replacement first; transfer the persistent app identity only after selective deletion succeeds.
    await prisma.$transaction([
      prisma.imapMessage.deleteMany({
        where: {
          id: replacement.id,
          emailAccountId: this.mailbox.emailAccountId,
        },
      }),
      prisma.imapMessage.updateMany({
        where: {
          id: oldMapping.id,
          emailAccountId: this.mailbox.emailAccountId,
        },
        data: {
          folderPath: newMapping.folderPath,
          uidValidity: newMapping.uidValidity,
          uid: newMapping.uid,
          flags: newMapping.flags,
          internalDate: newMapping.internalDate,
          deleted: false,
        },
      }),
    ]);
  }
  async draftEmail(
    email: ParsedMessage,
    args: Parameters<EmailProvider["draftEmail"]>[1],
    userEmail: string,
    executedRule?: Parameters<EmailProvider["draftEmail"]>[3],
  ) {
    if (executedRule) {
      if (executedRule.emailAccountId !== this.mailbox.emailAccountId)
        throw new Error("Mailbox account mismatch.");
      const previous = await handlePreviousDraftDeletion({
        client: this,
        executedRule,
        logger,
      });
      if (!previous.shouldCreateDraft)
        return { draftId: previous.existingDraftId };
    }
    const draft = await this.appendDraft({
      from: userEmail,
      to: args.to ?? email.headers["reply-to"] ?? email.headers.from,
      cc: args.cc,
      bcc: args.bcc,
      subject:
        args.subject ??
        (/^re:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`),
      html: args.content,
      attachments: args.attachments,
      ...replyMailOptions(email),
    });
    return { draftId: draft.id };
  }
  async sendDraft(draftId: string) {
    if (!(await this.getDraft(draftId))) throw new ImapMessageNotFoundError();
    const sent = await sendImapMail(
      this.mailbox,
      await draftMailOptions(this.mailbox, draftId),
    );
    let warning = sent.storageWarning;
    try {
      await this.mailbox.removeMessages([draftId]);
    } catch {
      warning = "Message sent, but its original draft could not be removed.";
    }
    return {
      messageId: sent.id,
      threadId: sent.threadId,
      storageWarning: warning,
    };
  }
  async sendEmail(args: Parameters<EmailProvider["sendEmail"]>[0]) {
    const sent = await sendImapMail(this.mailbox, {
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: args.subject,
      text: args.messageText,
      attachments: args.attachments,
    });
    return { messageId: sent.id };
  }
  async sendEmailWithHtml(body: SendEmailBody) {
    if (body.providerDraftId && !(await this.getDraft(body.providerDraftId)))
      throw new ImapMessageNotFoundError();
    const sent = await sendImapMail(this.mailbox, {
      from: body.from,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      replyTo: body.replyTo,
      subject: body.subject,
      html: body.messageHtml,
      attachments: toMailerAttachments(body.attachments),
      inReplyTo: body.replyToEmail?.headerMessageId,
      references: body.replyToEmail?.headerMessageId
        ? `${body.replyToEmail.references ?? ""} ${body.replyToEmail.headerMessageId}`.trim()
        : undefined,
    });
    let warning = sent.storageWarning;
    if (body.providerDraftId) {
      try {
        await this.mailbox.removeMessages([body.providerDraftId]);
      } catch {
        warning = "Message sent, but its original draft could not be removed.";
      }
    }
    return {
      messageId: sent.id,
      threadId: sent.threadId,
      storageWarning: warning,
    };
  }
  async replyToEmail(
    email: ParsedMessage,
    content: string,
    options: Parameters<EmailProvider["replyToEmail"]>[2] = {},
  ) {
    const sent = await sendImapMail(this.mailbox, {
      from: options.from,
      to: options.replyTo ?? email.headers["reply-to"] ?? email.headers.from,
      subject: /^re:/i.test(email.subject)
        ? email.subject
        : `Re: ${email.subject}`,
      html: content,
      attachments: options.attachments,
      ...replyMailOptions(email),
    });
    return { messageId: sent.id };
  }
  async forwardEmail(
    email: ParsedMessage,
    args: Parameters<EmailProvider["forwardEmail"]>[1],
  ) {
    const raw = await this.mailbox.getRawMessage(email.id);
    const sent = await sendImapMail(this.mailbox, {
      from: args.from,
      to: args.to,
      cc: args.cc,
      bcc: args.bcc,
      subject: /^fwd?:/i.test(email.subject)
        ? email.subject
        : `Fwd: ${email.subject}`,
      html: args.content ?? "",
      attachments: [
        {
          filename: "forwarded-message.eml",
          content: raw,
          contentType: "message/rfc822",
          contentDisposition: "attachment",
        },
      ],
    });
    return { messageId: sent.id };
  }

  async getAttachment(messageId: string, attachmentId: string) {
    const mail = await parseSource(await this.mailbox.getRawMessage(messageId));
    if (!/^\d+$/.test(attachmentId))
      throw new Error("Invalid attachment identifier.");
    const attachment = mail.attachments[Number(attachmentId)];
    if (!attachment) throw new Error("Attachment not found.");
    return {
      data: attachment.content.toString("base64"),
      size: attachment.size,
    };
  }
  async getAttachmentStream(
    messageId: string,
    attachmentId: string,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const attachment = await this.getAttachment(messageId, attachmentId);
    signal?.throwIfAborted();
    const content = Buffer.from(attachment.data, "base64");
    return new ReadableStream<Uint8Array>({
      start(controller) {
        if (signal?.aborted) controller.error(signal.reason);
        else {
          controller.enqueue(content);
          controller.close();
        }
      },
    });
  }
  async searchContacts(query: string) {
    const needle = query.trim().toLowerCase();
    const messages = await this.allMessages({
      search: needle
        ? { or: [{ from: needle }, { to: needle }, { cc: needle }] }
        : undefined,
    });
    const candidates = messages.flatMap((message) =>
      [
        message.headers.from,
        message.headers.to,
        message.headers.cc ?? "",
      ].flatMap((header) =>
        messageAddresses(header)
          .filter(
            (address) =>
              address.includes(needle) || header.toLowerCase().includes(needle),
          )
          .map((emailAddress) => ({ emailAddress })),
      ),
    );
    return normalizeContactCandidates(candidates);
  }
  async getSignatures() {
    const account = await prisma.emailAccount.findUnique({
      where: { id: this.mailbox.emailAccountId },
      select: { signature: true },
    });
    if (account?.signature)
      return [
        {
          email: this.mailbox.credentials.email,
          signature: account.signature,
          isDefault: true,
          displayName: this.mailbox.credentials.name ?? undefined,
        },
      ];
    for (const message of await this.getSentMessages(10)) {
      if (!message.textHtml) continue;
      const signature = extractSignatureFromHtml(message.textHtml);
      if (signature)
        return [
          {
            email: this.mailbox.credentials.email,
            signature,
            isDefault: true,
            displayName: this.mailbox.credentials.name ?? undefined,
          },
        ];
    }
    return [];
  }
  async createAutoArchiveFilter(
    _options: Parameters<EmailProvider["createAutoArchiveFilter"]>[0],
  ): Promise<{ status: number }> {
    throw new ImapCapabilityError(
      "Server-side mail filters; use Inbox Zero automation rules instead",
    );
  }
  async createFilter(
    _options: Parameters<EmailProvider["createFilter"]>[0],
  ): Promise<{ status: number }> {
    throw new ImapCapabilityError("Server-side mail filters");
  }
  async deleteFilter(_id: string): Promise<{ status: number }> {
    throw new ImapCapabilityError("Server-side mail filters");
  }
  async getFiltersList(): Promise<never> {
    throw new ImapCapabilityError("Server-side mail filters");
  }
  async getForwardingAddresses(): Promise<string[]> {
    throw new ImapCapabilityError("Server-side forwarding configuration");
  }
  async blockUnsubscribedEmail(_messageId: string): Promise<void> {
    throw new ImapCapabilityError(
      "Server-side sender blocking; use Inbox Zero automation rules instead",
    );
  }
  async watchEmails(): Promise<never> {
    throw new ImapCapabilityError(
      "Push subscriptions; this mailbox uses server-side polling",
    );
  }
  async unwatchEmails(_subscriptionId?: string): Promise<void> {
    throw new ImapCapabilityError(
      "Push subscriptions; this mailbox uses server-side polling",
    );
  }
}

function groupThreads(messages: ParsedMessage[]): EmailThread[] {
  const groups = new Map<string, ParsedMessage[]>();
  for (const message of messages) {
    const group = groups.get(message.threadId) ?? [];
    group.push(message);
    groups.set(message.threadId, group);
  }
  return [...groups.entries()]
    .map(([id, group]) => {
      group.sort((a, b) => receivedTime(a) - receivedTime(b));
      return { id, messages: group, snippet: group[group.length - 1].snippet };
    })
    .sort(
      (a, b) =>
        receivedTime(b.messages[b.messages.length - 1]) -
        receivedTime(a.messages[a.messages.length - 1]),
    );
}

function toEmailLabel(label: CustomLabel): EmailLabel {
  const color = labelColorSchema.parse(label.color);
  return {
    id: label.id,
    name: label.name,
    type: "user",
    color: color ?? undefined,
    labelListVisibility: label.labelListVisibility ?? undefined,
    messageListVisibility: label.messageListVisibility ?? undefined,
  };
}
