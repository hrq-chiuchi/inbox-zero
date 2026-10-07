import "server-only";

import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Message } from "@microsoft/microsoft-graph-types";
import prisma from "@/utils/prisma";
import type { Prisma } from "@/generated/prisma/client";
import type { LocalMailSyncRequest } from "@/utils/actions/local-mail-sync.validation";
import type { LocalMailSyncResponse } from "@/utils/email/local-mail-sync-types";
import type { MailboxSyncPage } from "@/utils/email/types";
import { toLocalMailMessage } from "@/utils/email/local-mail-sync";
import { InvalidMailboxSyncCursorError } from "@/utils/email/mailbox-sync";
import {
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";
import type { ParsedMessage } from "@/utils/types";
import {
  type ImapMailbox,
  type ImapFolder,
  ImapMessageNotFoundError,
  ImapUidValidityChangedError,
} from "@/utils/imap/client";

const SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const UID_SCAN_WINDOW = 250;
const uid = z.number().int().min(0).max(4_294_967_295);
const entrySchema = z.object({
  uid,
  id: z.string(),
  flags: z.array(z.string()),
});
const eventSchema = z.object({
  id: z.string(),
  kind: z.enum(["upsert", "remove"]),
  message: z.custom<ParsedMessage>().optional(),
});
const chunkSchema = z.object({
  version: z.literal(1),
  kind: z.literal("uid-range"),
  group: z.string(),
  startUid: uid,
  endUid: uid,
  entries: z.array(entrySchema).max(UID_SCAN_WINDOW),
  events: z.array(eventSchema).max(UID_SCAN_WINDOW),
});
const stateSchema = z.object({
  version: z.literal(1),
  secret: z.string(),
  mode: z.enum(["folders", "changes", "backfill", "mailbox"]),
  folderId: z.string(),
  after: z.number().nullable(),
  before: z.number().nullable(),
  uidValidity: z.string(),
  maxUid: uid,
  nextUid: z.number().int().min(0).max(4_294_967_296),
  // Older persisted cursors must finish their already-started ascending pass.
  direction: z.enum(["ascending", "descending"]).default("ascending"),
  idle: z.boolean(),
  modseq: z.string().nullable(),
  exists: z.number().int().nonnegative(),
  previousGroup: z.string().nullable(),
  previousMaxUid: uid,
  currentGroup: z.string(),
  pending: z.array(eventSchema).max(UID_SCAN_WINDOW),
  folders: z.array(z.custom<ImapFolder>()).optional(),
  offset: z.number().int().nonnegative().optional(),
});
type State = z.infer<typeof stateSchema>;
type Scope = Pick<State, "mode" | "folderId" | "after" | "before">;
type ScanPage = {
  messages: ParsedMessage[];
  removed: string[];
  hasMore: boolean;
  cursor: string;
};
class ExpiredImapSyncSnapshotError extends Error {}

export async function syncImapLocalMail(
  mailbox: ImapMailbox,
  request: LocalMailSyncRequest,
  context: { emailAccountId: string },
): Promise<LocalMailSyncResponse> {
  if (
    !context.emailAccountId ||
    mailbox.emailAccountId !== context.emailAccountId
  )
    throw new Error("IMAP local mail account mismatch");
  try {
    switch (request.phase) {
      case "capabilities": {
        const folders = await mailbox.listFolders();
        return {
          status: "ok",
          phase: request.phase,
          result: {
            strategy: "folder-delta",
            excludedFolderIds: folders
              .filter(isExcludedFolder)
              .map((folder) => folder.id),
            maxHydrationMessages: 1,
          },
        };
      }
      case "folders": {
        validateLimit(request.limit);
        const scope: Scope = {
          mode: "folders",
          folderId: request.parentFolderId ?? "",
          after: null,
          before: null,
        };
        const state = request.cursor
          ? await loadSnapshot(mailbox.emailAccountId, request.cursor, scope)
          : {
              ...newState(scope),
              folders: request.parentFolderId
                ? []
                : await mailbox.listFolders(),
              offset: 0,
            };
        const folders = (state.folders ?? []).slice(
          state.offset ?? 0,
          (state.offset ?? 0) + request.limit,
        );
        state.offset = (state.offset ?? 0) + folders.length;
        const nextCursor =
          state.offset < (state.folders?.length ?? 0)
            ? await saveSnapshot(mailbox.emailAccountId, state)
            : undefined;
        return {
          status: "ok",
          phase: request.phase,
          result: {
            folders: folders.map((folder) => ({
              id: folder.id,
              parentFolderId: undefined,
              displayName: folder.name,
              childFolderCount: 0,
              isHidden: false,
              totalItemCount: folder.total,
              unreadItemCount: folder.unread,
            })),
            nextCursor,
          },
        };
      }
      case "folder-changes": {
        const page = await scanPage(
          mailbox,
          {
            mode: "changes",
            folderId: request.folderId,
            after: null,
            before: null,
          },
          request.cursor,
          request.limit,
        );
        return {
          status: "ok",
          phase: request.phase,
          result: {
            resetRequired: false,
            messages: page.messages.map(metadataPatch),
            removedMessageIds: page.removed,
            requiresReconciliationMessageIds: [],
            attachmentMetadataAvailable: false,
            cursor: page.cursor,
            hasMore: page.hasMore,
          },
        };
      }
      case "folder-backfill": {
        const page = await scanPage(
          mailbox,
          {
            mode: "backfill",
            folderId: request.folderId,
            after: request.after,
            before: request.before,
          },
          request.cursor,
          request.limit,
        );
        const messages = await hydrateMessages(mailbox, page.messages);
        return {
          status: "ok",
          phase: request.phase,
          result: {
            resetRequired: false,
            messages: messages.map((message) => ({
              message: toLocalMailMessage(message),
              changeKey: message.historyId,
              hasAttachments: message.hasAttachment,
              attachmentMetadataAvailable: false as const,
            })),
            nextCursor: page.hasMore ? page.cursor : undefined,
          },
        };
      }
      case "message-lookup": {
        try {
          const message = await mailbox.getMessage(request.messageId);
          const folders = await mailbox.listFolders();
          if (
            message.labelIds?.includes("DRAFT") ||
            folders.some(
              (folder) =>
                folder.id === message.parentFolderId &&
                isExcludedFolder(folder),
            )
          )
            return {
              status: "ok",
              phase: request.phase,
              result: { status: "notFound" },
            };
          return {
            status: "ok",
            phase: request.phase,
            result: {
              status: "found",
              message: toLocalMailMessage(message),
              changeKey: message.historyId,
              hasAttachments: message.hasAttachment,
              attachmentMetadataAvailable: false,
            },
          };
        } catch (error) {
          if (!(error instanceof ImapMessageNotFoundError)) throw error;
          return {
            status: "ok",
            phase: request.phase,
            result: { status: "notFound" },
          };
        }
      }
      default:
        return { status: "unsupported", strategy: "folder-delta" };
    }
  } catch (error) {
    if (
      error instanceof ExpiredImapSyncSnapshotError ||
      error instanceof InvalidMailboxSyncCursorError ||
      error instanceof ImapUidValidityChangedError
    )
      return { status: "reset-required", phase: request.phase };
    throw error;
  }
}

export async function getImapMailboxSyncPage(
  mailbox: ImapMailbox,
  options: { after?: Date; cursor?: string; folderId?: string; limit: number },
): Promise<MailboxSyncPage> {
  const folderId = options.folderId ?? "INBOX";
  let after = options.after?.getTime() ?? null;
  if (after !== null && !Number.isFinite(after))
    throw new Error("Invalid IMAP mailbox sync bounds");
  if (options.cursor && options.after === undefined) {
    const checkpoint = await loadSnapshot(
      mailbox.emailAccountId,
      options.cursor,
      undefined,
      true,
    );
    after = checkpoint.after;
  }
  let reset = false;
  let page: ScanPage;
  try {
    page = await scanPage(
      mailbox,
      { mode: "mailbox", folderId, after, before: null },
      options.cursor,
      options.limit,
    );
  } catch (error) {
    if (
      !(error instanceof ExpiredImapSyncSnapshotError) &&
      !(error instanceof ImapUidValidityChangedError)
    )
      throw error;
    reset = true;
    page = await scanPage(
      mailbox,
      { mode: "mailbox", folderId, after, before: null },
      undefined,
      options.limit,
    );
  }
  const mappings = page.removed.length
    ? await prisma.imapMessage.findMany({
        where: {
          emailAccountId: mailbox.emailAccountId,
          id: { in: page.removed },
        },
        select: { id: true, deleted: true, folderPath: true },
      })
    : [];
  const deleted = new Set(
    mappings
      .filter((mapping) => mapping.deleted && mapping.folderPath === folderId)
      .map((mapping) => mapping.id),
  );
  return {
    cursor: page.cursor,
    hasMore: page.hasMore,
    reset,
    deletedMessageIds: page.removed.filter((id) => deleted.has(id)),
    removedMessageIds: page.removed.filter((id) => !deleted.has(id)),
    upsertedMessages: page.messages,
  };
}

async function scanPage(
  mailbox: ImapMailbox,
  scope: Scope,
  cursor: string | undefined,
  limit: number,
): Promise<ScanPage> {
  validateLimit(limit);
  if (
    !scope.folderId ||
    (scope.after !== null && !Number.isFinite(scope.after)) ||
    (scope.before !== null &&
      (!Number.isFinite(scope.before) ||
        scope.before <= (scope.after ?? Number.NEGATIVE_INFINITY)))
  )
    throw new InvalidMailboxSyncCursorError();
  let state = cursor
    ? await loadSnapshot(mailbox.emailAccountId, cursor, scope)
    : newState(scope);
  await mailbox.withConnection(async (client) => {
    const lock = await client.getMailboxLock(scope.folderId, {
      readOnly: true,
    });
    try {
      const selected = client.mailbox;
      if (!selected) throw new Error("IMAP mailbox selection failed");
      const validity = selected.uidValidity.toString();
      if (state.uidValidity && state.uidValidity !== validity) {
        await prisma.imapMessage.updateMany({
          where: {
            emailAccountId: mailbox.emailAccountId,
            folderPath: scope.folderId,
            uidValidity: state.uidValidity,
          },
          data: { deleted: true },
        });
        throw new ImapUidValidityChangedError();
      }
      const modseq =
        !selected.noModseq && selected.highestModseq
          ? selected.highestModseq.toString()
          : null;
      if (
        state.idle &&
        modseq &&
        state.modseq === modseq &&
        state.exists === selected.exists &&
        selected.uidNext - 1 <= state.maxUid
      )
        return;
      if (!state.uidValidity || state.idle) {
        const maxUid = Math.max(selected.uidNext - 1, state.maxUid, 0);
        state = {
          ...state,
          uidValidity: validity,
          previousGroup: state.uidValidity ? state.currentGroup : null,
          previousMaxUid: state.maxUid,
          currentGroup: randomBytes(32).toString("base64url"),
          maxUid,
          nextUid:
            maxUid > 0
              ? Math.floor((maxUid - 1) / UID_SCAN_WINDOW) * UID_SCAN_WINDOW + 1
              : 0,
          direction: "descending",
          idle: false,
          modseq,
          exists: selected.exists,
          pending: [],
        };
      }
      if (
        state.pending.length ||
        state.nextUid === 0 ||
        state.nextUid > state.maxUid
      )
        return;
      const end = Math.min(state.maxUid, state.nextUid + UID_SCAN_WINDOW - 1);
      const nextUid =
        state.direction === "descending"
          ? Math.max(0, state.nextUid - UID_SCAN_WINDOW)
          : end + 1;
      const cached = await loadChunk(
        mailbox.emailAccountId,
        state.folderId,
        state.currentGroup,
        state.nextUid,
      );
      if (cached) {
        state.pending = cached.events;
        state.nextUid = nextUid;
        return;
      }
      const previousChunk =
        state.previousGroup && state.nextUid <= state.previousMaxUid
          ? await loadChunk(
              mailbox.emailAccountId,
              state.folderId,
              state.previousGroup,
              state.nextUid,
            )
          : null;
      if (
        state.previousGroup &&
        state.nextUid <= state.previousMaxUid &&
        !previousChunk
      )
        throw new ExpiredImapSyncSnapshotError();
      const current: z.infer<typeof entrySchema>[] = [];
      const rows = selected.exists
        ? await client.fetchAll(
            `${state.nextUid}:${end}`,
            {
              uid: true,
              flags: true,
              internalDate: true,
              envelope: true,
              headers: ["references", "in-reply-to"],
              bodyStructure: true,
            },
            { uid: true },
          )
        : [];
      if (state.direction === "descending") rows.sort((a, b) => b.uid - a.uid);
      const previous = new Map(
        (previousChunk?.entries ?? []).map((entry) => [entry.uid, entry]),
      );
      for (const row of rows) {
        // UID ranges can return the last extant UID even when the requested range is empty.
        if (row.uid < state.nextUid || row.uid > end) continue;
        const old = previous.get(row.uid);
        const flags = [...(row.flags ?? [])]
          .map((flag) => flag.toLowerCase())
          .filter((flag) => flag !== "\\recent")
          .sort();
        const date = new Date(row.internalDate ?? "").getTime();
        if (!Number.isFinite(date))
          throw new Error("IMAP returned an invalid internal date");
        const retained =
          !flags.includes("\\deleted") &&
          (scope.mode === "mailbox" || !flags.includes("\\draft")) &&
          (scope.after === null || date >= scope.after) &&
          (scope.before === null || date < scope.before);
        if (!retained) continue;
        previous.delete(row.uid);
        if (old && JSON.stringify(old.flags) === JSON.stringify(flags)) {
          current.push(old);
          continue;
        }
        const message = await mailbox.rememberMessageMetadata(
          scope.folderId,
          validity,
          row,
          selected.specialUse,
        );
        current.push({ uid: row.uid, id: message.id, flags });
        state.pending.push({ kind: "upsert", id: message.id, message });
      }
      for (const old of previous.values()) {
        state.pending.push({ kind: "remove", id: old.id });
        // An app move may already have transferred this stable ID to another tuple.
        await prisma.imapMessage.updateMany({
          where: {
            id: old.id,
            emailAccountId: mailbox.emailAccountId,
            folderPath: scope.folderId,
            uidValidity: validity,
            uid: BigInt(old.uid),
          },
          data: { deleted: true },
        });
      }
      await prisma.imapSyncSnapshot.create({
        data: {
          emailAccountId: mailbox.emailAccountId,
          folderPath: scope.folderId,
          expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS),
          state: JSON.parse(
            JSON.stringify({
              version: 1,
              kind: "uid-range",
              group: state.currentGroup,
              startUid: state.nextUid,
              endUid: end,
              entries: current,
              events: state.pending,
            }),
          ) as Prisma.InputJsonValue,
        },
      });
      state.nextUid = nextUid;
    } finally {
      lock.release();
    }
  });
  const events = state.pending.splice(0, limit);
  const hasMore =
    state.pending.length > 0 ||
    (state.nextUid > 0 && state.nextUid <= state.maxUid);
  state.idle = !hasMore;
  return {
    messages: events.flatMap((event) =>
      event.kind === "upsert" && event.message ? [event.message] : [],
    ),
    removed: events
      .filter((event) => event.kind === "remove")
      .map((event) => event.id),
    hasMore,
    cursor: await saveSnapshot(mailbox.emailAccountId, state),
  };
}

async function loadSnapshot(
  emailAccountId: string,
  cursor: string,
  scope?: Scope,
  allowExpired = false,
): Promise<State> {
  if (!/^[a-zA-Z0-9_-]{1,80}\.[a-zA-Z0-9_-]{43}$/.test(cursor))
    throw new InvalidMailboxSyncCursorError();
  const [id, secret] = cursor.split(".");
  const snapshot = await prisma.imapSyncSnapshot.findFirst({
    where: { id, emailAccountId },
  });
  if (!snapshot) throw new InvalidMailboxSyncCursorError();
  const parsed = stateSchema.safeParse(snapshot.state);
  if (!parsed.success) throw new InvalidMailboxSyncCursorError();
  const state = parsed.data;
  if (
    secret.length !== state.secret.length ||
    !timingSafeEqual(Buffer.from(secret), Buffer.from(state.secret))
  )
    throw new InvalidMailboxSyncCursorError();
  if (
    scope &&
    (state.mode !== scope.mode ||
      state.folderId !== scope.folderId ||
      state.after !== scope.after ||
      state.before !== scope.before ||
      snapshot.folderPath !== scope.folderId)
  )
    throw new InvalidMailboxSyncCursorError();
  if (!allowExpired && snapshot.expiresAt.getTime() <= Date.now())
    throw new ExpiredImapSyncSnapshotError();
  return state;
}

async function loadChunk(
  emailAccountId: string,
  folderPath: string,
  group: string,
  startUid: number,
) {
  const chunk = await prisma.imapSyncSnapshot.findFirst({
    where: {
      emailAccountId,
      folderPath,
      AND: [
        { state: { path: ["group"], equals: group } },
        { state: { path: ["startUid"], equals: startUid } },
      ],
    },
    orderBy: { id: "asc" },
  });
  if (!chunk) return null;
  if (chunk.expiresAt.getTime() <= Date.now())
    throw new ExpiredImapSyncSnapshotError();
  const parsed = chunkSchema.safeParse(chunk.state);
  if (!parsed.success) throw new InvalidMailboxSyncCursorError();
  return parsed.data;
}

async function saveSnapshot(emailAccountId: string, state: State) {
  state.secret = randomBytes(32).toString("base64url");
  const snapshot = await prisma.imapSyncSnapshot.create({
    data: {
      emailAccountId,
      folderPath: state.folderId,
      state: JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue,
      expiresAt: new Date(Date.now() + SNAPSHOT_TTL_MS),
    },
    select: { id: true },
  });
  return `${snapshot.id}.${state.secret}`;
}

function newState(scope: Scope): State {
  return {
    version: 1,
    secret: "",
    ...scope,
    uidValidity: "",
    maxUid: 0,
    nextUid: 1,
    direction: "descending",
    idle: false,
    modseq: null,
    exists: 0,
    previousGroup: null,
    previousMaxUid: 0,
    currentGroup: randomBytes(32).toString("base64url"),
    pending: [],
  };
}

function validateLimit(limit: number) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("IMAP sync limit must be between 1 and 100");
}

function isExcludedFolder(folder: ImapFolder) {
  return (
    ["\\Drafts", "\\Trash", "\\Junk"].includes(folder.specialUse ?? "") ||
    /^(drafts?|trash|deleted items|junk|spam)$/i.test(folder.id)
  );
}

async function hydrateMessages(
  mailbox: ImapMailbox,
  messages: ParsedMessage[],
) {
  const hydrated: ParsedMessage[] = [];
  for (const message of messages) {
    try {
      hydrated.push(await mailbox.getMessage(message.id));
    } catch (error) {
      if (!(error instanceof ImapMessageNotFoundError)) throw error;
    }
  }
  return hydrated;
}

function metadataPatch(
  message: ParsedMessage,
): Message & { id: string; internalDate: string; categoryIds: string[] } {
  const internalDate = message.internalDate;
  if (!internalDate || !Number.isFinite(Number(internalDate)))
    throw new Error("IMAP returned an invalid sync date");
  const recipient = (value: string) => ({
    emailAddress: {
      address: extractEmailAddress(value),
      name: extractNameFromEmail(value),
    },
  });
  const recipients = (value: string | undefined) =>
    splitRecipientList(value ?? "").map(recipient);
  const categories = (message.labelIds ?? []).filter(
    (label) =>
      ![
        "INBOX",
        "SENT",
        "DRAFT",
        "TRASH",
        "SPAM",
        "UNREAD",
        "STARRED",
      ].includes(label),
  );
  return {
    id: message.id,
    conversationId: message.threadId,
    internetMessageId: message.headers["message-id"],
    subject: message.subject,
    bodyPreview: message.snippet,
    from: recipient(message.headers.from),
    toRecipients: recipients(message.headers.to),
    ccRecipients: recipients(message.headers.cc),
    receivedDateTime: new Date(Number(internalDate)).toISOString(),
    internalDate,
    changeKey: message.historyId,
    isDraft: message.labelIds?.includes("DRAFT") ?? false,
    isRead: !message.labelIds?.includes("UNREAD"),
    flag: {
      flagStatus: message.labelIds?.includes("STARRED")
        ? "flagged"
        : "notFlagged",
    },
    categories,
    categoryIds: categories,
    parentFolderId: message.parentFolderId,
    hasAttachments: message.hasAttachment,
  };
}
