import { describe, expect, it } from "vitest";
import {
  conversationId,
  parseSource,
  toParsedMessage,
} from "@/utils/imap/message";

const mapping = {
  id: "persistent-message",
  threadId: "conversation",
  folderPath: "INBOX",
  flags: ["\\sEeN", "\\FLAGGED"],
  internalDate: new Date("2026-06-01T10:00:00Z"),
  uidValidity: "42",
  uid: 9n,
};

describe("IMAP MIME conversion", () => {
  it("decodes unicode MIME, distinguishes inline parts, and retains attachment indices", async () => {
    const source = Buffer.from(
      [
        "From: =?UTF-8?B?w4FsaWNl?= <alice@example.com>",
        "To: owner@example.com",
        "Message-ID: <root@example.com>",
        "Subject: =?UTF-8?B?SGVsbG8gw6k=?=",
        'Content-Type: multipart/mixed; boundary="boundary"',
        "",
        "--boundary",
        "Content-Type: text/plain; charset=utf-8",
        "Content-Transfer-Encoding: quoted-printable",
        "",
        "Body =C3=A9",
        "--boundary",
        'Content-Type: image/png; name="pixel.png"',
        'Content-Disposition: inline; filename="pixel.png"',
        "Content-ID: <pixel>",
        "Content-Transfer-Encoding: base64",
        "",
        "aW1hZ2U=",
        "--boundary",
        'Content-Type: application/pdf; name="invoice.pdf"',
        'Content-Disposition: attachment; filename="invoice.pdf"',
        "Content-Transfer-Encoding: base64",
        "",
        "cGRmLWJ5dGVz",
        "--boundary--",
        "",
      ].join("\r\n"),
    );
    const mail = await parseSource(source);
    const parsed = toParsedMessage(mail, mapping, "\\Inbox");
    expect(parsed.subject).toBe("Hello é");
    expect(parsed.textPlain).toContain("Body é");
    expect(parsed.headers.from).toContain("Álice");
    expect(parsed.attachments).toMatchObject([
      { attachmentId: "1", filename: "invoice.pdf", size: 9 },
    ]);
    expect(parsed.inline).toMatchObject([
      { attachmentId: "0", filename: "pixel.png" },
    ]);
    expect(parsed.hasAttachment).toBe(true);
    expect(parsed.labelIds).toContain("STARRED");
    expect(parsed.labelIds).not.toContain("UNREAD");
    expect(parsed.historyId).toBe("");
    expect(mail.attachments[1].content.toString()).toBe("pdf-bytes");
  });

  it("threads an RFC reply with its root while isolating accounts and unrelated subjects", async () => {
    const root = await parseSource(
      Buffer.from(
        "Message-ID: <root@example.com>\r\nSubject: Same subject\r\n\r\nRoot",
      ),
    );
    const reply = await parseSource(
      Buffer.from(
        "Message-ID: <reply@example.com>\r\nIn-Reply-To: <root@example.com>\r\nReferences: <root@example.com>\r\nSubject: Re: Same subject\r\n\r\nReply",
      ),
    );
    const unrelated = await parseSource(
      Buffer.from(
        "Message-ID: <unrelated@example.com>\r\nSubject: Same subject\r\n\r\nOther",
      ),
    );
    expect(conversationId("account", root, "fallback")).toBe(
      conversationId("account", reply, "fallback"),
    );
    expect(conversationId("other-account", root, "fallback")).not.toBe(
      conversationId("account", root, "fallback"),
    );
    expect(conversationId("account", unrelated, "fallback")).not.toBe(
      conversationId("account", root, "fallback"),
    );
  });
});
