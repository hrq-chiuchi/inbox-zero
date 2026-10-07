import { describe, expect, it, vi } from "vitest";
import type { ParsedMessage } from "@/utils/types";
import {
  compileImapQuery,
  compileThreadConditions,
  matchesMailboxSearch,
} from "@/utils/imap/query";
import { ImapCapabilityError } from "@/utils/imap/client";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));

const context = {
  now: new Date("2026-06-15T12:00:00Z"),
  labelNames: { work: "Work", newsletters: "Newsletters" },
};
function message(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    id: "message",
    threadId: "thread",
    historyId: "",
    date: "2026-06-10T12:00:00Z",
    internalDate: String(new Date("2026-06-10T12:00:00Z").getTime()),
    headers: {
      from: '"Alice" <alice@example.com>',
      to: "owner@example.com",
      subject: "Quarterly status",
      date: "2026-06-10T12:00:00Z",
    },
    subject: "Quarterly status",
    snippet: "A plan for next week",
    textPlain: "A plan for next week",
    inline: [],
    labelIds: ["INBOX", "UNREAD", "work"],
    ...overrides,
  };
}

describe("IMAP query behavior", () => {
  it("matches sender addresses and domains rather than display names or substrings", () => {
    expect(compileImapQuery("from:alice@example.com", context)(message())).toBe(
      true,
    );
    expect(compileImapQuery("from:@example.com", context)(message())).toBe(
      true,
    );
    expect(compileImapQuery("from:alice@exampl", context)(message())).toBe(
      false,
    );
    expect(
      compileImapQuery(
        "from:alice@example.com",
        context,
      )(
        message({
          headers: {
            ...message().headers,
            from: '"alice@example.com" <attacker@other.example>',
          },
        }),
      ),
    ).toBe(false);
  });

  it("preserves conjunctions, OR branches, grouped negation and quoted phrases", () => {
    const predicate = compileImapQuery(
      'in:inbox (from:alice@example.com OR from:bob@example.com) subject:"quarterly status" -label:Newsletters',
      context,
    );
    expect(predicate(message())).toBe(true);
    expect(predicate(message({ labelIds: ["INBOX", "newsletters"] }))).toBe(
      false,
    );
    expect(predicate(message({ subject: "Quarterly different status" }))).toBe(
      false,
    );
    expect(
      compileImapQuery("{from:bob@example.com -is:read}", context)(message()),
    ).toBe(true);
    expect(() => compileImapQuery("(from:alice@example.com", context)).toThrow(
      "Unbalanced",
    );
    expect(() => compileImapQuery('subject:"unfinished', context)).toThrow(
      "Unbalanced",
    );
  });

  it("uses precise internal timestamps instead of day-rounded IMAP dates", () => {
    const predicate = compileThreadConditions(
      {
        after: new Date("2026-06-10T11:59:59Z"),
        before: new Date("2026-06-10T12:00:01Z"),
        fromEmail: "alice@example.com",
        isUnread: true,
      },
      context,
    );
    expect(predicate(message())).toBe(true);
    expect(
      predicate(
        message({
          internalDate: String(new Date("2026-06-10T12:00:01Z").getTime()),
        }),
      ),
    ).toBe(false);
    expect(predicate(message({ labelIds: ["INBOX", "work"] }))).toBe(false);
  });

  it("ANDs required labels with match-any conditions and split exclusions", () => {
    const predicate = compileThreadConditions(
      {
        type: "inbox",
        labelIds: ["work"],
        anyOf: [{ fromEmail: "bob@example.com" }, { isUnread: true }],
      },
      context,
    );
    expect(predicate(message())).toBe(true);
    expect(predicate(message({ labelIds: ["INBOX", "UNREAD"] }))).toBe(false);
    const other = compileThreadConditions(
      {
        type: "inbox",
        excludeSplits: [
          {
            matchAll: true,
            filters: [{ kind: "LABEL", value: "work" }, { kind: "UNREAD" }],
          },
        ],
      },
      context,
    );
    expect(other(message())).toBe(false);
    expect(other(message({ labelIds: ["INBOX", "work"] }))).toBe(true);
  });

  it("surfaces categories and unknown operators before traversing an empty mailbox", () => {
    expect(() => compileImapQuery("category:promotions", context)).toThrow(
      ImapCapabilityError,
    );
    expect(() =>
      compileThreadConditions({ inboxSection: "focused" }, context),
    ).toThrow(ImapCapabilityError);
    expect(() => compileThreadConditions({ type: "snoozed" }, context)).toThrow(
      ImapCapabilityError,
    );
    expect(() =>
      compileThreadConditions(
        {
          excludeSplits: [
            {
              matchAll: false,
              filters: [{ kind: "CATEGORY", value: "promotions" }],
            },
          ],
        },
        context,
      ),
    ).toThrow(ImapCapabilityError);
  });

  it("applies every portable mailbox-search condition", () => {
    const search = {
      mailbox: "inbox" as const,
      read: false,
      starred: true,
      hasAttachment: true,
      excludedRoles: ["trash" as const],
      text: {
        kind: "text" as const,
        field: "subject" as const,
        match: "phrase" as const,
        value: "Quarterly status",
      },
    };
    expect(
      matchesMailboxSearch(
        message({
          hasAttachment: true,
          labelIds: ["INBOX", "UNREAD", "STARRED"],
        }),
        search,
      ),
    ).toBe(true);
    expect(
      matchesMailboxSearch(
        message({
          hasAttachment: true,
          labelIds: ["INBOX", "UNREAD", "STARRED", "TRASH"],
        }),
        search,
      ),
    ).toBe(false);
    expect(
      matchesMailboxSearch(
        message({ hasAttachment: true, labelIds: ["INBOX", "STARRED"] }),
        search,
      ),
    ).toBe(false);
    expect(
      matchesMailboxSearch(
        message({ labelIds: ["INBOX", "UNREAD", "STARRED"] }),
        search,
      ),
    ).toBe(false);
  });
});
