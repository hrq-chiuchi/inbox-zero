import { describe, expect, it, vi } from "vitest";
import type Mail from "nodemailer/lib/mailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { ImapAuthenticationError, ImapMailbox } from "@/utils/imap/client";
import {
  composeImapMail,
  ImapDeliveryError,
  sendImapRaw,
} from "@/utils/imap/mail";
import { parseSource } from "@/utils/imap/message";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));
const credentials = {
  email: "owner@example.com",
  password: "not-a-real-password",
  smtpPort: 465 as const,
};

function smtpMailbox() {
  const mailbox = new ImapMailbox("account", credentials);
  const sendMail = vi.fn();
  const close = vi.fn();
  vi.spyOn(mailbox, "getOrCreateSpecialFolder").mockResolvedValue("Sent");
  vi.spyOn(mailbox, "createSmtpTransport").mockReturnValue({
    sendMail,
    close,
  } as unknown as Mail<SMTPTransport.SentMessageInfo>);
  return { mailbox, sendMail, close };
}
const raw = Buffer.from(
  "From: owner@example.com\r\nTo: recipient@example.com\r\nMessage-ID: <send@example.com>\r\nSubject: Test\r\n\r\nTest body",
);
const envelope = { from: "owner@example.com", to: ["recipient@example.com"] };

describe("IMAP SMTP delivery", () => {
  it("preserves Bcc in stored drafts but never exposes it to delivered recipients", async () => {
    const mailbox = new ImapMailbox("account", credentials);
    const composed = await composeImapMail(mailbox, {
      to: "recipient@example.com",
      bcc: "hidden@example.com",
      subject: "Test",
      text: "A body",
    });
    expect((await parseSource(composed.storedRaw)).bcc).toBeDefined();
    expect((await parseSource(composed.raw)).bcc).toBeUndefined();
    expect(composed.envelope.to).toContain("hidden@example.com");
    expect((await parseSource(composed.raw)).text?.trim()).toBe("A body");
  });

  it("rejects a spoofed sender before opening either connection", async () => {
    const { mailbox, sendMail } = smtpMailbox();
    await expect(
      composeImapMail(mailbox, {
        from: "other@example.com",
        to: "recipient@example.com",
        subject: "Test",
      }),
    ).rejects.toThrow("connected mailbox");
    await expect(
      composeImapMail(mailbox, {
        from: '"owner@example.com" <other@example.com>',
        to: "recipient@example.com",
        subject: "Test",
      }),
    ).rejects.toThrow("connected mailbox");
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("returns proven SMTP acceptance when Sent storage fails, without retrying delivery", async () => {
    const { mailbox, sendMail, close } = smtpMailbox();
    sendMail.mockResolvedValue({
      accepted: ["recipient@example.com"],
      rejected: [],
    });
    vi.spyOn(mailbox, "appendMessage").mockRejectedValue(
      new Error("IMAP storage unavailable"),
    );
    const result = await sendImapRaw(
      mailbox,
      raw,
      envelope,
      "<send@example.com>",
    );
    expect(result.id).toBe("<send@example.com>");
    expect(result.storageWarning).toContain("Sent copy");
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps uncertain SMTP acceptance nonretryable and always closes transport", async () => {
    const { mailbox, sendMail, close } = smtpMailbox();
    sendMail.mockRejectedValue(new Error("socket disappeared after DATA"));
    await expect(
      sendImapRaw(mailbox, raw, envelope, "<send@example.com>"),
    ).rejects.toMatchObject({ deliveryState: "unknown", retryable: false });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("classifies an authentication rejection before SMTP acceptance", async () => {
    const { mailbox, sendMail, close } = smtpMailbox();
    sendMail.mockRejectedValue(
      Object.assign(new Error("Authentication failed"), { code: "EAUTH" }),
    );
    await expect(
      sendImapRaw(mailbox, raw, envelope, "<send@example.com>"),
    ).rejects.toBeInstanceOf(ImapAuthenticationError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("reports partial recipient acceptance instead of silently delivering or retrying", async () => {
    const { mailbox, sendMail } = smtpMailbox();
    sendMail.mockResolvedValue({
      accepted: ["recipient@example.com"],
      rejected: ["rejected@example.com"],
    });
    await expect(
      sendImapRaw(mailbox, raw, envelope, "<send@example.com>"),
    ).rejects.toBeInstanceOf(ImapDeliveryError);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});
