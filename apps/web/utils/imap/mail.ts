import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import type Mail from "nodemailer/lib/mailer";
import { ImapAuthenticationError, type ImapMailbox } from "@/utils/imap/client";
import { conversationId, parseSource } from "@/utils/imap/message";
import { messageAddresses } from "@/utils/imap/query";
import { buildThreadingHeaders } from "@/utils/email/threading";
import type { ParsedMessage } from "@/utils/types";
import { createScopedLogger } from "@/utils/logger";

export type ImapSendResult = {
  id: string;
  threadId: string;
  storageWarning?: string;
};
export const IMAP_ATTACHMENT_ID_HEADER = "X-Inbox-Zero-Attachment-Id";

const logger = createScopedLogger("imap/smtp");

export class ImapDeliveryError extends Error {
  readonly retryable = false;
  readonly deliveryState: "unknown" | "accepted";
  readonly rfcMessageId: string;

  constructor(deliveryState: "unknown" | "accepted", rfcMessageId: string) {
    super(
      deliveryState === "accepted"
        ? "SMTP accepted some recipients but rejected others. Do not resend to accepted recipients."
        : "SMTP delivery could not be confirmed. Check Sent mail and recipients before sending again.",
    );
    this.name = "ImapDeliveryError";
    this.deliveryState = deliveryState;
    this.rfcMessageId = rfcMessageId;
  }
}

export async function composeImapMail(
  mailbox: ImapMailbox,
  options: Mail.Options,
): Promise<{
  raw: Buffer;
  storedRaw: Buffer;
  envelope: { from: string; to: string[] };
  messageId: string;
}> {
  if (Array.isArray(options.from))
    throw new Error("A single connected sender address is required.");
  const requestedFrom =
    typeof options.from === "string" ? options.from : options.from?.address;
  if (
    requestedFrom &&
    (messageAddresses(requestedFrom).length !== 1 ||
      messageAddresses(requestedFrom)[0] !==
        mailbox.credentials.email.toLowerCase())
  )
    throw new Error(
      "Hostinger mail can only be sent from the connected mailbox address.",
    );
  const domain = mailbox.credentials.email.split("@")[1];
  const messageId = options.messageId ?? `<${randomUUID()}@${domain}>`;
  const message = new MailComposer({
    ...options,
    from: {
      name: mailbox.credentials.name ?? "",
      address: mailbox.credentials.email,
    },
    messageId,
    date: options.date ?? new Date(),
    disableFileAccess: true,
    disableUrlAccess: true,
  }).compile();
  message.keepBcc = true;
  const storedRaw = await message.build();
  const separator = storedRaw.indexOf("\r\n\r\n");
  if (separator < 0) throw new Error("Composed mail has invalid MIME headers.");
  const headers = storedRaw
    .subarray(0, separator + 2)
    .toString("utf8")
    .replace(/^Bcc:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*\r\n/gim, "");
  const raw = Buffer.concat([
    Buffer.from(headers),
    storedRaw.subarray(separator + 2),
  ]);
  const envelope = message.getEnvelope();
  return {
    raw,
    storedRaw,
    envelope: { from: mailbox.credentials.email, to: envelope.to },
    messageId,
  };
}

export function replyMailOptions(
  email: ParsedMessage,
): Pick<Mail.Options, "inReplyTo" | "references"> {
  const parentId = email.headers["message-id"];
  if (!parentId) return {};
  return buildThreadingHeaders({
    headerMessageId: parentId,
    references: email.headers.references,
  });
}

export async function sendImapMail(
  mailbox: ImapMailbox,
  options: Mail.Options,
): Promise<ImapSendResult> {
  const composed = await composeImapMail(mailbox, options);
  return sendImapRaw(
    mailbox,
    composed.raw,
    composed.envelope,
    composed.messageId,
    composed.storedRaw,
  );
}

export async function sendImapRaw(
  mailbox: ImapMailbox,
  raw: Buffer,
  envelope: { from: string; to: string[] },
  rfcMessageId: string,
  storedRaw = raw,
): Promise<ImapSendResult> {
  if (!envelope.to.length)
    throw new Error("At least one recipient is required.");
  const parsed = await parseSource(raw);
  if (
    envelope.from.toLowerCase() !== mailbox.credentials.email.toLowerCase() ||
    messageAddresses(parsed.from?.text).some(
      (address) => address !== mailbox.credentials.email.toLowerCase(),
    )
  )
    throw new Error("SMTP sender must be the connected mailbox.");
  const sentFolder = await mailbox.getOrCreateSpecialFolder("SENT");
  const transport = mailbox.createSmtpTransport();
  try {
    try {
      const result = await transport.sendMail({ raw, envelope });
      if (!result.accepted.length)
        throw new Error("No SMTP recipient accepted the message.");
      // Partial acceptance cannot be retried safely: already accepted recipients would get duplicates.
      if (result.rejected.length)
        throw new ImapDeliveryError("accepted", rfcMessageId);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EAUTH"
      )
        throw new ImapAuthenticationError();
      if (error instanceof ImapDeliveryError) throw error;
      throw new ImapDeliveryError("unknown", rfcMessageId);
    }
  } finally {
    transport.close();
  }
  try {
    return await mailbox.appendMessage(sentFolder, storedRaw, ["\\Seen"]);
  } catch {
    logger.warn("SMTP accepted message but its Sent copy could not be saved", {
      emailAccountId: mailbox.emailAccountId,
    });
    return {
      id: rfcMessageId,
      threadId: conversationId(mailbox.emailAccountId, parsed, rfcMessageId),
      storageWarning: "Message sent, but saving its Sent copy failed.",
    };
  }
}

export async function draftMailOptions(
  mailbox: ImapMailbox,
  messageId: string,
): Promise<Mail.Options> {
  const mail = await parseSource(await mailbox.getRawMessage(messageId));
  return {
    from: mail.from?.text,
    to: Array.isArray(mail.to)
      ? mail.to.map((item) => item.text).join(", ")
      : mail.to?.text,
    cc: Array.isArray(mail.cc)
      ? mail.cc.map((item) => item.text).join(", ")
      : mail.cc?.text,
    bcc: Array.isArray(mail.bcc)
      ? mail.bcc.map((item) => item.text).join(", ")
      : mail.bcc?.text,
    replyTo: mail.replyTo?.text,
    subject: mail.subject,
    text: mail.text,
    html: typeof mail.html === "string" ? mail.html : undefined,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    messageId: mail.messageId,
    attachments: mail.attachments.map((attachment) => {
      const attachmentId = attachment.headers.get(
        IMAP_ATTACHMENT_ID_HEADER.toLowerCase(),
      );
      return {
        filename: attachment.filename,
        content: attachment.content,
        contentType: attachment.contentType,
        contentDisposition: attachment.contentDisposition,
        cid: attachment.cid,
        headers:
          typeof attachmentId === "string"
            ? { [IMAP_ATTACHMENT_ID_HEADER]: attachmentId }
            : undefined,
      };
    }),
  };
}
