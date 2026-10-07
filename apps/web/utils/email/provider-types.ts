export function isGoogleProvider(
  provider: string | null | undefined,
): provider is "google" {
  return provider === "google";
}

export function isMicrosoftProvider(
  provider: string | null | undefined,
): provider is "microsoft" {
  return provider === "microsoft";
}

export function isImapProvider(
  provider: string | null | undefined,
): provider is "imap" {
  return provider === "imap";
}

export function isFolderProvider(
  provider: string | null | undefined,
): provider is "microsoft" | "imap" {
  return provider === "microsoft" || provider === "imap";
}
