import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ImapFlow,
  AuthenticationFailure,
  type FetchMessageObject,
  type SearchObject,
  type ImapFlowOptions,
} from "imapflow";
import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import type { ParsedMail } from "mailparser";
import type { ImapMessage } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import type { ParsedMessage } from "@/utils/types";
import {
  conversationId,
  parseSource,
  rfcMessageIds,
  SPECIAL_ROLES,
  toParsedMessage,
} from "@/utils/imap/message";
import { InvalidMailboxSyncCursorError } from "@/utils/email/mailbox-sync";

export type HostingerCredentials = {
  email: string;
  password: string;
  smtpPort: 465 | 587;
  name?: string | null;
};
export type ImapFolder = {
  id: string;
  name: string;
  delimiter: string;
  specialUse?: string;
  total: number;
  unread: number;
};
export type ImapEnvelopeMatch = {
  folder: string;
  uidValidity: string;
  uid: number;
  internalDate: Date;
  from: string[];
  to: string[];
};
type Mapping = ImapMessage;
type TestEndpoints = {
  host: "127.0.0.1" | "::1";
  imapPort: number;
  smtpPort: number;
  secure: boolean;
  rejectUnauthorized?: boolean;
};
const snapshotEntrySchema = z.object({
  folder: z.string(),
  validity: z.string(),
  uid: z.number().int().positive(),
  id: z.string().optional(),
});
const searchSnapshotSchema = z.object({
  entries: z.array(snapshotEntrySchema).max(100_000),
});
type SnapshotEntry = z.infer<typeof snapshotEntrySchema>;
const testEndpoints = new WeakMap<ImapMailbox, TestEndpoints>();
const FULL_FETCH = {
  source: true,
  flags: true,
  internalDate: true,
  envelope: true,
  uid: true,
} as const;

export class ImapUidValidityChangedError extends Error {
  constructor() {
    super(
      "Mailbox identity changed. Refresh the mailbox before accessing this message.",
    );
    this.name = "ImapUidValidityChangedError";
  }
}
export class ImapMessageNotFoundError extends Error {
  constructor() {
    super("Message no longer exists in this mailbox.");
    this.name = "ImapMessageNotFoundError";
  }
}
export class ImapCapabilityError extends Error {
  constructor(feature: string) {
    super(`${feature} is not supported by this IMAP server.`);
    this.name = "ImapCapabilityError";
  }
}
export class ImapAuthenticationError extends Error {
  constructor() {
    super("Hostinger authentication failed. Reconnect your mailbox.");
    this.name = "ImapAuthenticationError";
  }
}
export class ImapDisconnectedError extends Error {
  constructor() {
    super("Hostinger mailbox is disconnected. Reconnect to continue.");
    this.name = "ImapDisconnectedError";
  }
}

export async function createImapMailbox(
  emailAccountId: string,
): Promise<ImapMailbox> {
  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    include: { imapConnection: true, account: true },
  });
  if (
    !account?.imapConnection?.password ||
    account.account.provider !== "imap" ||
    account.account.disconnectedAt
  )
    throw new ImapDisconnectedError();
  const port = account.imapConnection.smtpPort;
  if (port !== 465 && port !== 587)
    throw new Error("Invalid Hostinger SMTP port.");
  return new ImapMailbox(emailAccountId, {
    email: account.email,
    name: account.name,
    password: account.imapConnection.password,
    smtpPort: port,
  });
}

export async function verifyHostingerCredentials(
  credentials: HostingerCredentials,
): Promise<void> {
  const mailbox = new ImapMailbox("credential-verification", credentials);
  await verifyMailboxCredentials(mailbox);
}

export async function verifyMailboxCredentials(
  mailbox: ImapMailbox,
): Promise<void> {
  const smtp = mailbox.createSmtpTransport();
  try {
    await mailbox.withConnection(async () => {
      await smtp.verify();
    });
  } catch {
    throw new Error(
      "Unable to authenticate Hostinger IMAP and SMTP. Check your mailbox credentials and SMTP port.",
    );
  } finally {
    smtp.close();
  }
}

export function createTestImapMailbox(
  emailAccountId: string,
  credentials: HostingerCredentials,
  endpoints: TestEndpoints,
): ImapMailbox {
  if (
    process.env.NODE_ENV !== "test" ||
    !["127.0.0.1", "::1"].includes(endpoints.host)
  )
    throw new Error("Local mailbox endpoints are only available in tests.");
  for (const port of [endpoints.imapPort, endpoints.smtpPort])
    if (!Number.isInteger(port) || port < 1 || port > 65_535)
      throw new Error("Invalid test mailbox port.");
  const mailbox = new ImapMailbox(emailAccountId, credentials);
  testEndpoints.set(mailbox, endpoints);
  return mailbox;
}

export class ImapMailbox {
  readonly emailAccountId: string;
  readonly #credentials: HostingerCredentials;
  get credentials(): HostingerCredentials {
    return this.#credentials;
  }
  constructor(emailAccountId: string, credentials: HostingerCredentials) {
    if (
      !credentials.email ||
      !credentials.password ||
      ![465, 587].includes(credentials.smtpPort)
    )
      throw new Error("Invalid Hostinger mailbox credentials.");
    this.emailAccountId = emailAccountId;
    this.#credentials = Object.freeze({
      ...credentials,
      email: credentials.email.trim().toLowerCase(),
    });
  }
  toJSON() {
    return { emailAccountId: this.emailAccountId, provider: "imap" };
  }

  createSmtpTransport() {
    const test = testEndpoints.get(this);
    const options: SMTPTransport.Options = {
      host: test?.host ?? "smtp.hostinger.com",
      port: test?.smtpPort ?? this.credentials.smtpPort,
      secure: test?.secure ?? this.credentials.smtpPort === 465,
      requireTLS: test ? test.secure : true,
      auth: { user: this.credentials.email, pass: this.credentials.password },
      forceAuth: true,
      tls: {
        rejectUnauthorized: test?.rejectUnauthorized ?? true,
        minVersion: "TLSv1.2",
      },
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    return nodemailer.createTransport(options);
  }

  async withConnection<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    const test = testEndpoints.get(this);
    const options: ImapFlowOptions = {
      host: test?.host ?? "imap.hostinger.com",
      port: test?.imapPort ?? 993,
      secure: test?.secure ?? true,
      auth: { user: this.credentials.email, pass: this.credentials.password },
      tls: {
        rejectUnauthorized: test?.rejectUnauthorized ?? true,
        minVersion: "TLSv1.2",
      },
      logger: false,
      logRaw: false,
      disableAutoIdle: true,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
    };
    const client = new ImapFlow(options);
    client.on("error", () => {
      client.close();
    });
    try {
      try {
        await client.connect();
      } catch (error) {
        if (
          error instanceof AuthenticationFailure ||
          (error &&
            typeof error === "object" &&
            "authenticationFailed" in error &&
            error.authenticationFailed)
        )
          throw new ImapAuthenticationError();
        throw new Error("Hostinger IMAP connection is unavailable.");
      }
      if (!test && !client.secureConnection)
        throw new Error("An encrypted IMAP connection is required.");
      return await fn(client);
    } finally {
      try {
        if (client.usable) await client.logout();
      } catch {
        /* Socket closure must not turn a completed mutation into a retry. */
      } finally {
        client.close();
      }
    }
  }

  async listFolders(): Promise<ImapFolder[]> {
    return this.withConnection(async (client) => {
      const folders = await client.list();
      const result: ImapFolder[] = [];
      for (const folder of folders) {
        if (folder.flags.has("\\Noselect")) continue;
        const status = await client.status(folder.path, {
          messages: true,
          unseen: true,
        });
        if (!status) throw new Error("Hostinger folder status is unavailable.");
        result.push({
          id: folder.path,
          name: folder.name,
          delimiter: folder.delimiter,
          specialUse: inferSpecialUse(folder.path, folder.specialUse),
          total: status.messages ?? 0,
          unread: status.unseen ?? 0,
        });
      }
      return result;
    });
  }

  async getOrCreateSpecialFolder(
    role: keyof typeof SPECIAL_ROLES,
  ): Promise<string> {
    const folders = await this.listFolders();
    const special = folders.find(
      (folder) => folder.specialUse === SPECIAL_ROLES[role],
    );
    if (special) return special.id;
    const names: Record<keyof typeof SPECIAL_ROLES, string[]> = {
      INBOX: ["INBOX"],
      DRAFT: ["Drafts", "Draft"],
      SENT: ["Sent", "Sent Items", "Sent Messages"],
      ARCHIVE: ["Archive", "Archives"],
      TRASH: ["Trash", "Deleted Items"],
      SPAM: ["Junk", "Spam", "Junk E-mail"],
    };
    const existing = folders.find((folder) =>
      names[role].some(
        (name) => folder.name.toLowerCase() === name.toLowerCase(),
      ),
    );
    if (existing) return existing.id;
    return this.withConnection(
      async (client) => (await client.mailboxCreate(names[role][0])).path,
    );
  }

  async resolveMessage(messageId: string): Promise<Mapping> {
    const mapping = await prisma.imapMessage.findFirst({
      where: {
        id: messageId,
        emailAccountId: this.emailAccountId,
        deleted: false,
      },
    });
    if (!mapping) throw new ImapMessageNotFoundError();
    return mapping;
  }

  async checkValidity(client: ImapFlow, mapping: Mapping): Promise<void> {
    if (
      !client.mailbox ||
      String(client.mailbox.uidValidity) !== mapping.uidValidity
    ) {
      await prisma.imapMessage.updateMany({
        where: {
          emailAccountId: this.emailAccountId,
          folderPath: mapping.folderPath,
          uidValidity: mapping.uidValidity,
        },
        data: { deleted: true },
      });
      throw new ImapUidValidityChangedError();
    }
  }

  async getRawMessage(messageId: string): Promise<Buffer> {
    const mapping = await this.resolveMessage(messageId);
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(mapping.folderPath);
      try {
        await this.checkValidity(client, mapping);
        const message = await client.fetchOne(Number(mapping.uid), FULL_FETCH, {
          uid: true,
        });
        if (!message?.source) {
          await prisma.imapMessage.updateMany({
            where: { id: mapping.id, emailAccountId: this.emailAccountId },
            data: { deleted: true },
          });
          throw new ImapMessageNotFoundError();
        }
        return message.source;
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(messageId: string): Promise<ParsedMessage> {
    const mapping = await this.resolveMessage(messageId);
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(mapping.folderPath);
      try {
        await this.checkValidity(client, mapping);
        const message = await client.fetchOne(Number(mapping.uid), FULL_FETCH, {
          uid: true,
        });
        if (!message?.source) {
          await prisma.imapMessage.updateMany({
            where: { id: mapping.id, emailAccountId: this.emailAccountId },
            data: { deleted: true },
          });
          throw new ImapMessageNotFoundError();
        }
        return this.rememberMessage(
          mapping.folderPath,
          mapping.uidValidity,
          message,
          client.mailbox ? client.mailbox.specialUse : undefined,
        );
      } finally {
        lock.release();
      }
    });
  }

  async rememberMessage(
    folderPath: string,
    uidValidity: string,
    message: FetchMessageObject,
    specialUse?: string,
  ): Promise<ParsedMessage> {
    if (!message.source)
      throw new Error(
        "Full MIME source is required to hydrate an IMAP message.",
      );
    return this.rememberParsed(
      folderPath,
      uidValidity,
      message,
      await parseSource(message.source),
      specialUse,
    );
  }

  async rememberMessageMetadata(
    folderPath: string,
    uidValidity: string,
    message: FetchMessageObject,
    specialUse?: string,
  ): Promise<ParsedMessage> {
    if (!message.envelope)
      throw new Error("IMAP envelope is required for metadata mapping.");
    const mail = await parseSource(message.headers ?? Buffer.from("\r\n"));
    const envelope = message.envelope;
    const clean = (value: string | undefined) =>
      (value ?? "").replace(/[\r\n]/g, " ");
    const format = (addresses: typeof envelope.from) =>
      addresses
        ?.map((address) =>
          address.name
            ? `${JSON.stringify(clean(address.name))} <${clean(address.address)}>`
            : clean(address.address),
        )
        .join(", ") ?? "";
    const envelopeHeaders = Buffer.from(
      `From: ${format(envelope.from)}\r\nTo: ${format(envelope.to)}\r\nCc: ${format(envelope.cc)}\r\nBcc: ${format(envelope.bcc)}\r\nReply-To: ${format(envelope.replyTo)}\r\nSubject: ${clean(envelope.subject)}\r\nMessage-ID: ${clean(envelope.messageId)}\r\nIn-Reply-To: ${clean(envelope.inReplyTo ?? mail.inReplyTo)}\r\nReferences: ${clean(Array.isArray(mail.references) ? mail.references.join(" ") : mail.references)}\r\n\r\n`,
    );
    const parsedMail = await parseSource(envelopeHeaders);
    if (envelope.date) parsedMail.date = new Date(envelope.date);
    const parsed = await this.rememberParsed(
      folderPath,
      uidValidity,
      message,
      parsedMail,
      specialUse,
    );
    if (message.bodyStructure) {
      const parts = [message.bodyStructure];
      while (parts.length) {
        const part = parts.pop()!;
        parts.push(...(part.childNodes ?? []));
        if (part.disposition?.toLowerCase() === "attachment")
          parsed.hasAttachment = true;
        if (part.type?.toLowerCase() === "text/calendar")
          parsed.isMeetingInvitation = true;
      }
    }
    return parsed;
  }

  private async rememberParsed(
    folderPath: string,
    uidValidity: string,
    message: FetchMessageObject,
    mail: ParsedMail,
    specialUse?: string,
  ) {
    if (!message.internalDate || !message.flags)
      throw new Error("IMAP flags and internal date are required.");
    const tuple = {
      emailAccountId: this.emailAccountId,
      folderPath,
      uidValidity,
      uid: BigInt(message.uid),
    };
    let threadId = conversationId(
      this.emailAccountId,
      mail,
      `${folderPath}:${uidValidity}:${message.uid}`,
    );
    const references = [
      ...rfcMessageIds(mail.references),
      ...rfcMessageIds(mail.inReplyTo),
    ];
    if (references.length) {
      const parent = await prisma.imapMessage.findFirst({
        where: {
          emailAccountId: this.emailAccountId,
          rfcMessageId: { in: references },
        },
        orderBy: { internalDate: "asc" },
      });
      if (parent) threadId = parent.threadId;
    }
    const mapping = await prisma.imapMessage.upsert({
      where: { emailAccountId_folderPath_uidValidity_uid: tuple },
      create: {
        ...tuple,
        threadId,
        rfcMessageId: mail.messageId,
        flags: [...message.flags],
        internalDate: new Date(message.internalDate),
      },
      update: {
        flags: [...message.flags],
        internalDate: new Date(message.internalDate),
        threadId,
        rfcMessageId: mail.messageId,
        deleted: false,
      },
    });
    if (mail.messageId) {
      const ownRoot = conversationId(
        this.emailAccountId,
        { ...mail, references: undefined, inReplyTo: undefined },
        mapping.id,
      );
      if (ownRoot !== threadId)
        await prisma.imapMessage.updateMany({
          where: { emailAccountId: this.emailAccountId, threadId: ownRoot },
          data: { threadId },
        });
    }
    const parsed = toParsedMessage(
      mail,
      mapping,
      inferSpecialUse(folderPath, specialUse),
    );
    const labels = await prisma.imapLabel.findMany({
      where: { emailAccountId: this.emailAccountId },
    });
    const keywordLabels = new Map(
      labels.map((label) => [label.keyword, label.id]),
    );
    parsed.labelIds = parsed.labelIds?.map(
      (label) => keywordLabels.get(label) ?? label,
    );
    return parsed;
  }

  async fetchMessages(
    options: {
      folderId?: string;
      search?: SearchObject;
      uids?: number[];
      maxResults?: number;
      pageToken?: string;
      includeDrafts?: boolean;
    } = {},
  ): Promise<{ messages: ParsedMessage[]; nextPageToken?: string }> {
    if (options.search?.draft && !options.includeDrafts)
      throw new Error("Draft searches require includeDrafts.");
    if (
      options.uids?.some(
        (uid) => !Number.isSafeInteger(uid) || uid < 1 || uid > 4_294_967_295,
      )
    )
      throw new Error("Invalid IMAP UID selection.");
    const limit = Math.min(Math.max(options.maxResults ?? 50, 1), 1000);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          folder: options.folderId,
          search: options.search,
          uids: options.uids,
          drafts: options.includeDrafts,
        }),
      )
      .digest("hex");
    let entries: SnapshotEntry[];
    let snapshotId: string;
    let offset = 0;
    if (options.pageToken) {
      const match = /^imap-page:([a-z0-9]+):(\d+)$/.exec(options.pageToken);
      if (!match) throw new InvalidMailboxSyncCursorError();
      const snapshot = await prisma.imapSyncSnapshot.findFirst({
        where: {
          id: match[1],
          emailAccountId: this.emailAccountId,
          folderPath: `search:${fingerprint}`,
          expiresAt: { gt: new Date() },
        },
      });
      if (!snapshot) throw new InvalidMailboxSyncCursorError();
      const state = searchSnapshotSchema.safeParse(snapshot.state);
      if (!state.success) throw new InvalidMailboxSyncCursorError();
      entries = state.data.entries;
      snapshotId = snapshot.id;
      offset = Number(match[2]);
      if (!Number.isSafeInteger(offset) || offset > entries.length)
        throw new InvalidMailboxSyncCursorError();
    } else {
      entries = await this.withConnection(async (client) => {
        const folders = options.folderId
          ? [
              {
                path: options.folderId,
                flags: new Set<string>(),
                specialUse: undefined,
              },
            ]
          : await client.list();
        const result: SnapshotEntry[] = [];
        for (const folder of folders) {
          if (
            folder.flags.has("\\Noselect") ||
            (!options.includeDrafts && folder.specialUse === "\\Drafts")
          )
            continue;
          const lock = await client.getMailboxLock(folder.path, {
            readOnly: true,
          });
          try {
            if (!client.mailbox)
              throw new Error("IMAP folder could not be selected.");
            // Empty selected folders cannot match; avoid issuing SEARCH to them.
            // A false SEARCH result is a command failure, not an empty result.
            if (client.mailbox.exists === 0) continue;
            const validity = String(client.mailbox.uidValidity);
            const search = {
              ...options.search,
              ...(!options.includeDrafts ? { draft: false } : {}),
            };
            const found = await client.search(
              Object.keys(search).length ? search : { all: true },
              { uid: true },
            );
            if (!found)
              throw new Error(
                `IMAP search did not complete in folder "${folder.path}".`,
              );
            const requested = options.uids ? new Set(options.uids) : undefined;
            const selected = found
              .filter((uid) => !requested || requested.has(uid))
              .sort((a, b) => b - a);
            if (result.length + selected.length > 100_000)
              throw new Error(
                "Mailbox search exceeds the safe snapshot bound; narrow the query to a folder or date range.",
              );
            const idsByUid = new Map<number, string>();
            for (let start = 0; start < selected.length; start += 1000) {
              const known = await prisma.imapMessage.findMany({
                where: {
                  emailAccountId: this.emailAccountId,
                  folderPath: folder.path,
                  uidValidity: validity,
                  uid: { in: selected.slice(start, start + 1000).map(BigInt) },
                  deleted: false,
                },
                select: { id: true, uid: true },
              });
              for (const message of known)
                idsByUid.set(Number(message.uid), message.id);
            }
            for (const uid of selected)
              result.push({
                folder: folder.path,
                validity,
                uid,
                id: idsByUid.get(uid),
              });
          } finally {
            lock.release();
          }
        }
        return result;
      });
      const snapshot = await prisma.imapSyncSnapshot.create({
        data: {
          emailAccountId: this.emailAccountId,
          folderPath: `search:${fingerprint}`,
          state: { entries },
          expiresAt: new Date(Date.now() + 30 * 60_000),
        },
      });
      snapshotId = snapshot.id;
    }
    const messages = await this.withConnection(async (client) => {
      const result: ParsedMessage[] = [];
      while (offset < entries.length && result.length < limit) {
        let entry = entries[offset++];
        if (entry.id) {
          const live = await prisma.imapMessage.findFirst({
            where: {
              id: entry.id,
              emailAccountId: this.emailAccountId,
              deleted: false,
            },
          });
          if (!live) continue;
          entry = {
            folder: live.folderPath,
            validity: live.uidValidity,
            uid: Number(live.uid),
            id: live.id,
          };
        }
        const lock = await client.getMailboxLock(entry.folder, {
          readOnly: true,
        });
        try {
          if (
            !client.mailbox ||
            String(client.mailbox.uidValidity) !== entry.validity
          )
            throw new ImapUidValidityChangedError();
          const message = await client.fetchOne(entry.uid, FULL_FETCH, {
            uid: true,
          });
          if (message?.source)
            result.push(
              await this.rememberMessage(
                entry.folder,
                entry.validity,
                message,
                client.mailbox.specialUse,
              ),
            );
        } finally {
          lock.release();
        }
      }
      return result;
    });
    return {
      messages,
      nextPageToken:
        offset < entries.length
          ? `imap-page:${snapshotId}:${offset}`
          : undefined,
    };
  }

  // Server-side search that returns addresses and dates only. Callers that just
  // need to know whether a correspondent appears must not download message bodies.
  async searchEnvelopes(options: {
    search: SearchObject;
    excludeRoles?: (keyof typeof SPECIAL_ROLES)[];
    maxPerFolder?: number;
  }): Promise<ImapEnvelopeMatch[]> {
    const excluded = new Set<string>(
      (options.excludeRoles ?? []).map((role) => SPECIAL_ROLES[role]),
    );
    const maxPerFolder = Math.min(
      Math.max(options.maxPerFolder ?? 200, 1),
      1000,
    );
    const addresses = (list: { address?: string }[] | undefined): string[] =>
      (list ?? []).flatMap((item) =>
        item.address ? [item.address.toLowerCase()] : [],
      );
    return this.withConnection(async (client) => {
      const result: ImapEnvelopeMatch[] = [];
      for (const folder of await client.list()) {
        const role = inferSpecialUse(folder.path, folder.specialUse);
        if (
          folder.flags.has("\\Noselect") ||
          role === SPECIAL_ROLES.DRAFT ||
          (role && excluded.has(role))
        )
          continue;
        const lock = await client.getMailboxLock(folder.path, {
          readOnly: true,
        });
        try {
          if (!client.mailbox)
            throw new Error("IMAP folder could not be selected.");
          if (client.mailbox.exists === 0) continue;
          const found = await client.search(
            { ...options.search, draft: false },
            { uid: true },
          );
          if (!found)
            throw new Error(
              `IMAP search did not complete in folder "${folder.path}".`,
            );
          const uids = found.sort((a, b) => a - b).slice(0, maxPerFolder);
          if (!uids.length) continue;
          const uidValidity = String(client.mailbox.uidValidity);
          // No other command may run on this connection while the fetch iterates.
          for await (const message of client.fetch(
            uids,
            { envelope: true, internalDate: true, uid: true },
            { uid: true },
          )) {
            if (!message.envelope || !message.internalDate) continue;
            result.push({
              folder: folder.path,
              uidValidity,
              uid: message.uid,
              internalDate: new Date(message.internalDate),
              from: addresses(message.envelope.from),
              to: addresses(message.envelope.to),
            });
          }
        } finally {
          lock.release();
        }
      }
      return result;
    });
  }

  private async operateMessages(
    messageIds: string[],
    operation: (client: ImapFlow, mappings: Mapping[]) => Promise<void>,
  ) {
    if (!messageIds.length) return;
    const groups = new Map<string, Mapping[]>();
    for (const id of new Set(messageIds)) {
      const mapping = await this.resolveMessage(id);
      const group = groups.get(mapping.folderPath) ?? [];
      group.push(mapping);
      groups.set(mapping.folderPath, group);
    }
    await this.withConnection(async (client) => {
      for (const [folder, mappings] of groups) {
        const lock = await client.getMailboxLock(folder);
        try {
          for (const mapping of mappings)
            await this.checkValidity(client, mapping);
          const live = await client.fetchAll(
            mappings.map((mapping) => Number(mapping.uid)),
            { uid: true, flags: true },
            { uid: true },
          );
          const byUid = new Map(live.map((message) => [message.uid, message]));
          for (const mapping of mappings) {
            const message = byUid.get(Number(mapping.uid));
            if (!message) throw new ImapMessageNotFoundError();
            if (message.flags) mapping.flags = [...message.flags];
          }
          await operation(client, mappings);
        } finally {
          lock.release();
        }
      }
    });
  }

  async moveMessages(messageIds: string[], folderPath: string): Promise<void> {
    await this.operateMessages(messageIds, async (client, mappings) => {
      if (mappings[0].folderPath === folderPath) return;
      if (!client.capabilities.has("UIDPLUS"))
        throw new ImapCapabilityError("Stable message moves (UIDPLUS)");
      const result = await client.messageMove(
        mappings.map((mapping) => Number(mapping.uid)),
        folderPath,
        { uid: true },
      );
      if (!result?.uidValidity || !result.uidMap)
        throw new Error(
          "Move completed without a UID mapping. Refresh the mailbox; do not retry the move.",
        );
      for (const mapping of mappings) {
        const uid = result.uidMap.get(Number(mapping.uid));
        if (!uid)
          throw new Error(
            "Moved message UID was not returned. Refresh the mailbox.",
          );
        await prisma.imapMessage.updateMany({
          where: { id: mapping.id, emailAccountId: this.emailAccountId },
          data: {
            folderPath,
            uidValidity: String(result.uidValidity),
            uid: BigInt(uid),
          },
        });
      }
    });
  }

  async setFlags(
    messageIds: string[],
    flags: string[],
    add: boolean,
  ): Promise<void> {
    await this.operateMessages(messageIds, async (client, mappings) => {
      const uids = mappings.map((mapping) => Number(mapping.uid));
      if (client.mailbox?.permanentFlags)
        for (const flag of flags) {
          if (
            !flag.startsWith("\\") &&
            !client.mailbox.permanentFlags.has("\\*") &&
            !client.mailbox.permanentFlags.has(flag)
          )
            throw new ImapCapabilityError("Custom keyword labels");
        }
      const ok = add
        ? await client.messageFlagsAdd(uids, flags, { uid: true })
        : await client.messageFlagsRemove(uids, flags, { uid: true });
      if (!ok) throw new Error("IMAP flag update failed.");
      for (const mapping of mappings)
        await prisma.imapMessage.updateMany({
          where: { id: mapping.id, emailAccountId: this.emailAccountId },
          data: {
            flags: add
              ? [...new Set([...mapping.flags, ...flags])]
              : mapping.flags.filter((flag) => !flags.includes(flag)),
          },
        });
    });
  }

  async removeMessages(messageIds: string[]): Promise<void> {
    await this.operateMessages(messageIds, async (client, mappings) => {
      if (!client.capabilities.has("UIDPLUS"))
        throw new ImapCapabilityError("Selective permanent deletion (UIDPLUS)");
      if (
        !(await client.messageDelete(
          mappings.map((mapping) => Number(mapping.uid)),
          { uid: true },
        ))
      )
        throw new Error("IMAP selective deletion failed.");
      await prisma.imapMessage.updateMany({
        where: {
          id: { in: mappings.map((mapping) => mapping.id) },
          emailAccountId: this.emailAccountId,
        },
        data: { deleted: true },
      });
    });
  }

  async appendMessage(
    folderPath: string,
    raw: Buffer,
    flags: string[] = [],
  ): Promise<ParsedMessage> {
    const mail = await parseSource(raw);
    return this.withConnection(async (client) => {
      const lock = await client.getMailboxLock(folderPath);
      try {
        if (!client.mailbox)
          throw new Error("IMAP folder could not be selected.");
        const beforeUid = client.mailbox.uidNext;
        const appended = await client.append(
          folderPath,
          raw,
          flags,
          new Date(),
        );
        if (!appended) throw new Error("IMAP APPEND failed.");
        let uid = appended.uid;
        if (!uid) {
          if (!mail.messageId)
            throw new Error(
              "APPEND accepted without a message identifier. Do not retry.",
            );
          const found = await client.search(
            { uid: `${beforeUid}:*`, header: { "message-id": mail.messageId } },
            { uid: true },
          );
          if (found?.length !== 1)
            throw new Error(
              "APPEND accepted but identity is ambiguous. Do not retry.",
            );
          uid = found[0];
        }
        const message = await client.fetchOne(uid, FULL_FETCH, { uid: true });
        if (!message?.source)
          throw new Error(
            "APPEND accepted but message could not be read. Do not retry.",
          );
        return this.rememberMessage(
          folderPath,
          String(appended.uidValidity ?? client.mailbox.uidValidity),
          message,
          client.mailbox.specialUse,
        );
      } finally {
        lock.release();
      }
    });
  }
}

function inferSpecialUse(
  path: string,
  specialUse?: string,
): string | undefined {
  if (specialUse) return specialUse;
  const name = path.split(/[/.]/).pop()?.toLowerCase() ?? path.toLowerCase();
  const conventional: Record<string, string> = {
    inbox: "\\Inbox",
    drafts: "\\Drafts",
    draft: "\\Drafts",
    sent: "\\Sent",
    "sent items": "\\Sent",
    "sent messages": "\\Sent",
    archive: "\\Archive",
    archives: "\\Archive",
    trash: "\\Trash",
    "deleted items": "\\Trash",
    junk: "\\Junk",
    spam: "\\Junk",
    "junk e-mail": "\\Junk",
  };
  return conventional[name];
}
