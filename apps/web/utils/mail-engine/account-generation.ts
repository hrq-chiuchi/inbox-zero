import type { Provider } from "@inboxzero/mail-core/identities";

const IMAP_CACHE_GENERATION = 2;

export function localMailGeneration(account: {
  accountId: string;
  provider: Provider;
  generation?: string;
}) {
  if (account.generation) return account.generation;
  return account.provider === "imap"
    ? `${account.accountId}:imap:${IMAP_CACHE_GENERATION}`
    : account.accountId;
}
