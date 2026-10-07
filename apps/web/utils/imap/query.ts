import addressparser from "nodemailer/lib/addressparser";
import type { ParsedMessage } from "@/utils/types";
import type {
  ThreadsQuery,
  ThreadsQueryLeaf,
} from "@/utils/threads/validation";
import type { ProviderMailboxSearch } from "@/utils/email/types";
import { ImapCapabilityError } from "@/utils/imap/client";

type MessagePredicate = (message: ParsedMessage) => boolean;
export type ImapQueryContext = {
  labelNames: Record<string, string>;
  now: Date;
};

export function messageAddresses(value: string | undefined): string[] {
  return addressparser(value ?? "", { flatten: true })
    .map((address) => address.address.toLowerCase())
    .filter(Boolean);
}

export function matchesSender(message: ParsedMessage, sender: string): boolean {
  const value = sender.trim().toLowerCase();
  return messageAddresses(message.headers.from).some((address) =>
    value.startsWith("@") ? address.endsWith(value) : address === value,
  );
}

export function receivedTime(message: ParsedMessage): number {
  return message.internalDate
    ? Number(message.internalDate)
    : new Date(message.date).getTime();
}

export function compileImapQuery(
  query: string,
  context: ImapQueryContext,
): MessagePredicate {
  if (query.replace(/"[^"]*"/g, "").includes('"'))
    throw new Error("Unbalanced quoted search phrase.");
  const tokens = query.match(/-?[(){}]|(?:[^\s(){}"]|"[^"]*")+/g) ?? [];
  let position = 0;
  function expression(closing?: string, matchAny = false): MessagePredicate {
    const groups: MessagePredicate[][] = [[]];
    while (position < tokens.length) {
      let token = tokens[position++];
      if (token === closing) break;
      if (token === ")" || token === "}")
        throw new Error("Unbalanced mail search query.");
      if (token.toUpperCase() === "OR" || token === "|") {
        groups.push([]);
        continue;
      }
      const negate = token.startsWith("-");
      if (negate) token = token.slice(1);
      let predicate: MessagePredicate;
      if (token === "(" || token === "{") {
        predicate = expression(token === "(" ? ")" : "}", token === "{");
        if (tokens[position - 1] !== (token === "(" ? ")" : "}"))
          throw new Error("Unbalanced mail search query.");
      } else predicate = term(token, context);
      if (matchAny && groups[groups.length - 1].length) groups.push([]);
      groups[groups.length - 1].push(
        negate ? (message) => !predicate(message) : predicate,
      );
    }
    if (groups.some((group) => !group.length) && tokens.length)
      throw new Error("Invalid mail search expression.");
    return (message) =>
      groups.some((group) => group.every((predicate) => predicate(message)));
  }
  return expression();
}

export function compileThreadConditions(
  query: ThreadsQuery,
  context: ImapQueryContext,
): MessagePredicate {
  if (
    query.type &&
    ![
      "all",
      "inbox",
      "unread",
      "starred",
      "sent",
      "draft",
      "drafts",
      "trash",
      "spam",
      "archive",
    ].includes(query.type)
  )
    throw new ImapCapabilityError(`Mailbox view ${query.type}`);
  if (query.inboxSection || query.category || query.splitId)
    throw new ImapCapabilityError("Provider categories and focused inbox");
  for (const leaf of query.anyOf ?? [])
    if (leaf.inboxSection)
      throw new ImapCapabilityError("Focused inbox splits");
  for (const split of query.excludeSplits ?? [])
    for (const filter of split.filters)
      if (filter.kind === "CATEGORY")
        throw new ImapCapabilityError("Provider category splits");
  const text = compileImapQuery(query.q ?? "", context);
  const requiredLabels = [
    ...(query.labelIds ?? []),
    ...(query.labelId ? [query.labelId] : []),
  ];
  const excludedNames = new Set(query.excludeLabelNames ?? []);
  const anyOf = (query.anyOf ?? []).map((leaf) => compileLeaf(leaf));
  const excludedSplits = (query.excludeSplits ?? []).map((split) => {
    const predicates = split.filters.map((filter): MessagePredicate => {
      switch (filter.kind) {
        case "UNREAD":
          return (message) => message.labelIds?.includes("UNREAD") ?? false;
        case "STARRED":
          return (message) => message.labelIds?.includes("STARRED") ?? false;
        case "FROM":
          return (message) => matchesSender(message, filter.value ?? "");
        case "LABEL":
          return (message) =>
            message.labelIds?.includes(filter.value ?? "") ?? false;
        case "OLDER_THAN": {
          const days: Record<string, number> = { "3d": 3, "1w": 7, "1m": 30 };
          if (!days[filter.value ?? ""])
            throw new Error("Unsupported split age condition.");
          const cutoff =
            context.now.getTime() - days[filter.value ?? ""] * 86_400_000;
          return (message) => receivedTime(message) < cutoff;
        }
        default:
          throw new ImapCapabilityError(`Split condition ${filter.kind}`);
      }
    });
    return (message: ParsedMessage) =>
      split.matchAll
        ? predicates.every((predicate) => predicate(message))
        : predicates.some((predicate) => predicate(message));
  });
  return (message) => {
    const labels = message.labelIds ?? [];
    if (
      !text(message) ||
      (query.fromEmail && !matchesSender(message, query.fromEmail))
    )
      return false;
    if (query.folderId && message.parentFolderId !== query.folderId)
      return false;
    if (query.isUnread && !labels.includes("UNREAD")) return false;
    if (query.after && receivedTime(message) <= query.after.getTime())
      return false;
    if (query.before && receivedTime(message) >= query.before.getTime())
      return false;
    if (!requiredLabels.every((label) => labels.includes(label))) return false;
    if (
      query.anyLabelIds?.length &&
      !query.anyLabelIds.some((label) => labels.includes(label))
    )
      return false;
    if (anyOf.length && !anyOf.some((predicate) => predicate(message)))
      return false;
    if (
      labels.some((label) =>
        excludedNames.has(context.labelNames[label] ?? label),
      )
    )
      return false;
    if (excludedSplits.some((predicate) => predicate(message))) return false;
    switch (query.type) {
      case undefined:
      case null:
      case "all":
        return true;
      case "inbox":
        return labels.includes("INBOX");
      case "unread":
        return labels.includes("INBOX") && labels.includes("UNREAD");
      case "starred":
        return labels.includes("STARRED");
      case "sent":
        return labels.includes("SENT");
      case "draft":
      case "drafts":
        return labels.includes("DRAFT");
      case "trash":
        return labels.includes("TRASH");
      case "spam":
        return labels.includes("SPAM");
      case "archive":
        return labels.includes("ARCHIVE");
      default:
        throw new ImapCapabilityError(`Mailbox view ${query.type}`);
    }
  };
}

export function matchesMailboxSearch(
  message: ParsedMessage,
  search: ProviderMailboxSearch,
): boolean {
  const labels = message.labelIds ?? [];
  const roles: Record<string, string> = {
    inbox: "INBOX",
    sent: "SENT",
    drafts: "DRAFT",
    draft: "DRAFT",
    trash: "TRASH",
    spam: "SPAM",
    archive: "ARCHIVE",
    starred: "STARRED",
  };
  if (search.mailbox !== "all" && !labels.includes(roles[search.mailbox]))
    return false;
  if (search.read !== undefined && labels.includes("UNREAD") === search.read)
    return false;
  if (
    search.starred !== undefined &&
    labels.includes("STARRED") !== search.starred
  )
    return false;
  if (
    search.hasAttachment !== undefined &&
    !!message.hasAttachment !== search.hasAttachment
  )
    return false;
  if (search.excludedRoles?.some((role) => labels.includes(roles[role])))
    return false;
  if (search.text) {
    const { field, value } = search.text;
    const content =
      field === "subject"
        ? message.subject
        : field === "body"
          ? `${message.textPlain ?? ""}\n${message.textHtml ?? ""}`
          : `${Object.values(message.headers).join("\n")}\n${message.textPlain ?? ""}\n${message.textHtml ?? ""}`;
    if (!content.toLowerCase().includes(value.toLowerCase())) return false;
  }
  return true;
}

function compileLeaf(leaf: ThreadsQueryLeaf): MessagePredicate {
  return (message) =>
    (!leaf.labelId || !!message.labelIds?.includes(leaf.labelId)) &&
    (!leaf.fromEmail || matchesSender(message, leaf.fromEmail)) &&
    (!leaf.isUnread || !!message.labelIds?.includes("UNREAD")) &&
    (!leaf.before || receivedTime(message) < leaf.before.getTime());
}

function term(token: string, context: ImapQueryContext): MessagePredicate {
  const separator = token.indexOf(":");
  const operator =
    separator < 0 ? "text" : token.slice(0, separator).toLowerCase();
  const value = (separator < 0 ? token : token.slice(separator + 1))
    .replace(/^"|"$/g, "")
    .toLowerCase();
  if (!value) throw new Error("Search condition is missing a value.");
  switch (operator) {
    case "from":
      return (message) => matchesSender(message, value);
    case "to":
    case "cc":
    case "bcc":
      return (message) =>
        messageAddresses(message.headers[operator]).some((address) =>
          value.startsWith("@") ? address.endsWith(value) : address === value,
        );
    case "subject":
      return (message) => message.subject.toLowerCase().includes(value);
    case "text":
      return (message) =>
        `${Object.values(message.headers).join("\n")}\n${message.textPlain ?? ""}\n${message.textHtml ?? ""}`
          .toLowerCase()
          .includes(value);
    case "in":
    case "label": {
      const aliases: Record<string, string> = {
        inbox: "INBOX",
        sent: "SENT",
        drafts: "DRAFT",
        draft: "DRAFT",
        trash: "TRASH",
        spam: "SPAM",
        junk: "SPAM",
        archive: "ARCHIVE",
        starred: "STARRED",
        unread: "UNREAD",
      };
      if (value === "anywhere" || value === "all") return () => true;
      const id =
        aliases[value] ??
        Object.entries(context.labelNames).find(
          ([, name]) => name.toLowerCase() === value,
        )?.[0] ??
        value;
      return (message) =>
        (message.labelIds ?? []).some(
          (label) => label.toLowerCase() === id.toLowerCase(),
        );
    }
    case "is": {
      if (
        !["unread", "read", "starred", "unstarred", "draft", "sent"].includes(
          value,
        )
      )
        throw new ImapCapabilityError(`Search is:${value}`);
      return (message) =>
        value === "read"
          ? !message.labelIds?.includes("UNREAD")
          : value === "unstarred"
            ? !message.labelIds?.includes("STARRED")
            : !!message.labelIds?.includes(
                (
                  {
                    unread: "UNREAD",
                    starred: "STARRED",
                    draft: "DRAFT",
                    sent: "SENT",
                  } as Record<string, string>
                )[value],
              );
    }
    case "has": {
      if (value !== "attachment")
        throw new ImapCapabilityError(`Search has:${value}`);
      return (message) => !!message.hasAttachment;
    }
    case "filename":
      return (message) =>
        [...(message.attachments ?? []), ...message.inline].some((attachment) =>
          attachment.filename.toLowerCase().includes(value),
        );
    case "rfc822msgid":
      return (message) =>
        message.headers["message-id"]?.replace(/^<|>$/g, "").toLowerCase() ===
        value.replace(/^<|>$/g, "");
    case "after":
    case "newer":
    case "before":
    case "older": {
      const date = /^\d+$/.test(value)
        ? Number(value) * 1000
        : new Date(value.replace(/\//g, "-")).getTime();
      if (!Number.isFinite(date)) throw new Error("Invalid mail search date.");
      return (message) =>
        operator === "after" || operator === "newer"
          ? receivedTime(message) > date
          : receivedTime(message) < date;
    }
    case "older_than":
    case "newer_than": {
      const match = /^(\d+)([dwmy])$/.exec(value);
      if (!match) throw new Error("Invalid relative mail search date.");
      const days =
        Number(match[1]) *
        ({ d: 1, w: 7, m: 30, y: 365 } as Record<string, number>)[match[2]];
      const cutoff = context.now.getTime() - days * 86_400_000;
      return (message) =>
        operator === "older_than"
          ? receivedTime(message) < cutoff
          : receivedTime(message) > cutoff;
    }
    case "larger":
    case "smaller":
    case "size":
      throw new ImapCapabilityError("MIME size search");
    default:
      throw new ImapCapabilityError(`Search operator ${operator}`);
  }
}
