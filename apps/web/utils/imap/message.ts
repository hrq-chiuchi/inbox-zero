import { createHash } from "node:crypto";
import { simpleParser, type ParsedMail } from "mailparser";
import type { ParsedMessage } from "@/utils/types";

export const SPECIAL_ROLES = {
  INBOX: "\\Inbox",
  DRAFT: "\\Drafts",
  SENT: "\\Sent",
  ARCHIVE: "\\Archive",
  TRASH: "\\Trash",
  SPAM: "\\Junk",
} as const;

export function rfcMessageIds(value: string | string[] | undefined): string[] {
  return (
    (Array.isArray(value) ? value.join(" ") : (value ?? "")).match(
      /<[^<>\s]+>/g,
    ) ?? []
  );
}

export function conversationId(
  accountId: string,
  mail: ParsedMail,
  fallback: string,
): string {
  const root =
    rfcMessageIds(mail.references)[0] ??
    rfcMessageIds(mail.inReplyTo)[0] ??
    mail.messageId ??
    fallback;
  return `imap-thread-${createHash("sha256").update(`${accountId}\0${root}`).digest("hex")}`;
}

export async function parseSource(source: Buffer): Promise<ParsedMail> {
  return simpleParser(source, {
    skipImageLinks: true,
    skipHtmlToText: false,
    skipTextToHtml: true,
  });
}

export function toParsedMessage(
  mail: ParsedMail,
  mapping: {
    id: string;
    threadId: string;
    folderPath: string;
    flags: string[];
    internalDate: Date;
    uidValidity: string;
    uid: bigint;
  },
  specialUse?: string,
): ParsedMessage {
  const labels = [mapping.folderPath];
  const role = Object.entries(SPECIAL_ROLES).find(
    ([, value]) => value.toLowerCase() === specialUse?.toLowerCase(),
  )?.[0];
  if (role && !labels.includes(role)) labels.push(role);
  if (mapping.folderPath.toUpperCase() === "INBOX" && !labels.includes("INBOX"))
    labels.push("INBOX");
  const flags = new Set(mapping.flags.map((flag) => flag.toLowerCase()));
  if (!flags.has("\\seen")) labels.push("UNREAD");
  if (flags.has("\\flagged")) labels.push("STARRED");
  if (flags.has("\\draft") && !labels.includes("DRAFT")) labels.push("DRAFT");
  labels.push(...mapping.flags.filter((flag) => !flag.startsWith("\\")));
  const attachments = mail.attachments.map((attachment, index) => ({
    attachmentId: String(index),
    filename: attachment.filename ?? "attachment",
    mimeType: attachment.contentType,
    size: attachment.size,
    headers: {
      "content-description": attachment.filename ?? "",
      "content-id": attachment.contentId ?? "",
      "content-transfer-encoding": "base64",
      "content-type": attachment.contentType,
      "content-disposition": attachment.contentDisposition,
    },
  }));
  const address = (value: ParsedMail["to"]) =>
    Array.isArray(value)
      ? value.map((item) => item.text).join(", ")
      : (value?.text ?? "");
  const header = (name: string) => {
    const value = mail.headers.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const date = (mail.date ?? mapping.internalDate).toISOString();
  return {
    id: mapping.id,
    threadId: mapping.threadId,
    historyId: "",
    internalDate: String(mapping.internalDate.getTime()),
    date,
    subject: mail.subject ?? "",
    headers: {
      from: address(mail.from),
      to: address(mail.to),
      cc: address(mail.cc),
      bcc: address(mail.bcc),
      subject: mail.subject ?? "",
      date,
      "message-id": mail.messageId,
      "in-reply-to": mail.inReplyTo,
      references: Array.isArray(mail.references)
        ? mail.references.join(" ")
        : mail.references,
      "reply-to": address(mail.replyTo),
      "list-unsubscribe": header("list-unsubscribe"),
      "list-unsubscribe-post": header("list-unsubscribe-post"),
    },
    textPlain: mail.text,
    textHtml: typeof mail.html === "string" ? mail.html : undefined,
    bodyContentType: mail.html ? "html" : "text",
    snippet: (mail.text ?? "").replace(/\s+/g, " ").slice(0, 250),
    attachments: attachments.filter(
      (_, index) => mail.attachments[index].contentDisposition !== "inline",
    ),
    inline: attachments.filter(
      (_, index) => mail.attachments[index].contentDisposition === "inline",
    ),
    hasAttachment: attachments.some(
      (_, index) => mail.attachments[index].contentDisposition !== "inline",
    ),
    calendarContent: mail.attachments
      .find((item) => item.contentType === "text/calendar")
      ?.content.toString("utf8"),
    isMeetingInvitation: mail.attachments.some(
      (item) => item.contentType === "text/calendar",
    ),
    labelIds: [...new Set(labels)],
    parentFolderId: mapping.folderPath,
  };
}
