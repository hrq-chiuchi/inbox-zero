"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { holdMailEngineOwner } from "./owner-lock";
import { reportMailEngineStartupFailure } from "./startup-failure";
import type { MailEngineStartupStage } from "./startup-error";
import { usePathname } from "next/navigation";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";
import { LoadingContent } from "@/components/LoadingContent";
import { env } from "@/env";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  createBrowserMailEngine,
  type BrowserMailEngine,
} from "@/utils/mail-engine/create-browser-engine";
import {
  startDesktopIpcMailClient,
  hasDesktopMailEngineIpc,
} from "@/utils/mail-engine/desktop-ipc";
import {
  selectMailEngineRuntimeMode,
  shouldStartMailEngine,
} from "@/utils/mail-engine/runtime-mode";
import { providerSchema, type Provider } from "@inboxzero/mail-core/identities";
import {
  fetchEmailAccounts,
  subscribeEmailAccounts,
} from "@/utils/fetch-email-accounts";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { followMailboxChanges } from "@/utils/mail-engine/follow-mailbox-changes";
import { browserMailEngineCapabilities } from "@/utils/mail-engine/worker-protocol";
import {
  MAIL_ENGINE_TAB_CHANNEL,
  bindTabMailOwner,
  createBroadcastTabBus,
  createTabFollowerClient,
  disposeTabFollowerClient,
} from "@/utils/mail-engine/tab-channel";
import {
  setActiveMailClient,
  subscribeMailEngineLogout,
} from "@/utils/mail-engine/active-client";

type MailEngineRuntimeStatus = {
  client: MailClient | null;
  mounted: boolean;
  failed: boolean;
  retry: () => void;
  requestBrowserEngine: () => void;
};

type MailEngineInspectTransport = "browser" | "desktop-ipc";

const MailEngineRuntimeStatusContext = createContext<MailEngineRuntimeStatus>({
  client: null,
  mounted: false,
  failed: false,
  retry: () => {},
  requestBrowserEngine: () => {},
});

export function useMailEngineDemand() {
  const { requestBrowserEngine } = useContext(MailEngineRuntimeStatusContext);
  useEffect(requestBrowserEngine, [requestBrowserEngine]);
}

export function MailEngineRuntime({ children }: { children: ReactNode }) {
  const status = useContext(MailEngineRuntimeStatusContext);
  if (status.mounted) return children;
  return <MailEngineRuntimeInner>{children}</MailEngineRuntimeInner>;
}

export function MailEngineHost({ children }: { children: ReactNode }) {
  return (
    <MailEngineRuntime>
      <MailCoverageGate>{children}</MailCoverageGate>
    </MailEngineRuntime>
  );
}

export function MailCoverageGate({ children }: { children: ReactNode }) {
  const status = useContext(MailEngineRuntimeStatusContext);
  // SSR has no OPFS; checking capabilities before hydration paints the
  // storage-error shell instead of the shared loading state.
  const isClient = useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

  if (!isClient) {
    return <LoadingContent loading>{null}</LoadingContent>;
  }
  const mode = selectMailEngineRuntimeMode({
    desktopIpc: hasDesktopMailEngineIpc(),
    ...browserMailEngineCapabilities(),
  });
  if (status.failed || mode === "unavailable") {
    return (
      <Empty role="alert">
        <EmptyHeader>
          <EmptyMedia variant="icon" className="bg-destructive/10">
            <AlertCircle className="text-destructive" />
          </EmptyMedia>
          <EmptyTitle>
            {status.failed
              ? "Mail couldn’t start"
              : "This browser doesn’t support Mail"}
          </EmptyTitle>
          <EmptyDescription>
            {status.failed
              ? "Try again. If this continues, use a non-private window and an up-to-date browser."
              : "Mail requires a browser with persistent file storage (OPFS) and web workers. Use an up-to-date browser in a non-private window."}
          </EmptyDescription>
        </EmptyHeader>
        {status.failed && (
          <Button variant="outline" onClick={status.retry}>
            Retry
          </Button>
        )}
      </Empty>
    );
  }
  if (!status.client) {
    return <LoadingContent loading>{null}</LoadingContent>;
  }
  return children;
}

function MailEngineRuntimeInner({ children }: { children: ReactNode }) {
  const { emailAccountId, provider } = useAccount();
  const pathname = usePathname();
  const desktopIpc = useSyncExternalStore(
    subscribeNever,
    hasDesktopMailEngineIpc,
    () => false,
  );
  const [browserRequested, setBrowserRequested] = useState(false);
  const requestBrowserEngine = useCallback(() => setBrowserRequested(true), []);
  const enabled = shouldStartMailEngine({
    pathname,
    desktopIpc,
    browserRequested,
  });
  const [client, setClient] = useState<MailClient | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setFailed(false);
    setAttempt((value) => value + 1);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry must tear down the previous attempt and start a new engine.
  useEffect(() => {
    if (!emailAccountId || !provider || !enabled) {
      setFailed(false);
      return;
    }
    // Keep queued sends and undo working after the initiating page or composer closes.
    if (!desktopIpc) requestBrowserEngine();
    setFailed(false);
    const capabilities = browserMailEngineCapabilities();
    const mode = selectMailEngineRuntimeMode({ desktopIpc, ...capabilities });
    if (mode === "unavailable") {
      return;
    }
    const parsedProvider = providerSchema.safeParse(provider);
    if (!parsedProvider.success) {
      setFailed(true);
      return;
    }
    const mailProvider = parsedProvider.data;
    const abort = new AbortController();
    let published: MailClient | undefined;
    let unsubscribeAccounts: (() => void) | undefined;
    let stage: MailEngineStartupStage =
      mode === "desktop-ipc" ? "desktop-client" : "owner-lock";
    function fail(error: unknown) {
      if (abort.signal.aborted) return;
      setFailed(true);
      report(error, stage);
    }

    function report(error: unknown, stage: MailEngineStartupStage) {
      if (abort.signal.aborted) return;
      reportMailEngineStartupFailure(error, {
        runtimeMode: mode,
        platform: getInboxZeroDesktopApp() ? "desktop" : "web",
        capabilities,
        stage,
      });
    }

    async function publishClient(
      next: MailClient,
      role: "owner" | "follower",
      transport: MailEngineInspectTransport,
      ensureAccount?: (account: {
        accountId: string;
        provider: Provider;
      }) => Promise<void>,
    ) {
      if (abort.signal.aborted) return;
      stage = "publish-client";
      if (published && published !== next) disposeTabFollowerClient(published);
      published = next;
      if (ensureAccount) {
        const registered = new Map<string, Provider>([
          [emailAccountId, mailProvider],
        ]);
        let reconciliation = Promise.resolve();
        const reconcileAccounts = ({
          emailAccounts,
        }: GetEmailAccountsResponse) => {
          reconciliation = reconciliation
            .then(async () => {
              if (abort.signal.aborted || emailAccounts.length === 0) return;
              // Preserve the open account for org admins viewing a member's mail.
              await next.retainAccounts([
                emailAccountId,
                ...emailAccounts.map((account) => account.id),
              ]);
              if (abort.signal.aborted) return;
              const connected = new Set([emailAccountId]);
              const added: string[] = [];
              await Promise.all(
                emailAccounts.map(async (account) => {
                  if (account.account.disconnectedAt !== null) return;
                  const parsed = providerSchema.safeParse(
                    account.account.provider,
                  );
                  if (!parsed.success) return;
                  connected.add(account.id);
                  if (registered.get(account.id) === parsed.data) return;
                  try {
                    await ensureAccount({
                      accountId: account.id,
                      provider: parsed.data,
                    });
                    registered.set(account.id, parsed.data);
                    added.push(account.id);
                  } catch {
                    // A failed account must not block the other combined rows.
                  }
                }),
              );
              for (const accountId of registered.keys()) {
                if (!connected.has(accountId)) registered.delete(accountId);
              }
              if (
                added.length &&
                transport === "browser" &&
                !abort.signal.aborted
              ) {
                await next.requestSync(added);
              }
            })
            .catch(() => undefined);
          return reconciliation;
        };
        // Register before publishing: combined consumers can request sync as soon
        // as the client is available, even without visiting each account's route.
        await fetchEmailAccounts()
          .then(reconcileAccounts)
          .catch(() => undefined);
        if (abort.signal.aborted) return;
        unsubscribeAccounts?.();
        unsubscribeAccounts = subscribeEmailAccounts((accounts) => {
          reconcileAccounts(accounts).catch(() => undefined);
        });
      }
      publishMailEngineInspect(next, emailAccountId, role, transport);
      setActiveMailClient(next);
      setFailed(false);
      setClient(next);
    }

    if (mode === "desktop-ipc") {
      startDesktopIpcMailClient({
        provider: mailProvider,
        accountId: emailAccountId,
        publish: (client) => publishClient(client, "owner", "desktop-ipc"),
        onSyncError: (error) => report(error, "desktop-sync"),
      }).catch(fail);
      const unsubscribeLogout = subscribeMailEngineLogout(() => abort.abort());
      return () => {
        unsubscribeLogout();
        unsubscribeAccounts?.();
        abort.abort();
        if (published) disposeTabFollowerClient(published);
        clearMailEngineInspect();
        setActiveMailClient(null);
        setClient(null);
      };
    }

    let engine: BrowserMailEngine | undefined;
    let unbindOwner: (() => void) | undefined;
    let unbindHello: (() => void) | undefined;
    let channel: BroadcastChannel | null = null;
    stage = "tab-channel";
    try {
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(MAIL_ENGINE_TAB_CHANNEL);
      }
    } catch (error) {
      fail(error);
      return;
    }
    const bus = channel ? createBroadcastTabBus(channel) : null;

    if (bus) {
      unbindHello = bus.subscribe((message) => {
        if (message.type === "ready" && !engine && !published) {
          bus.post({
            type: "hello",
            accountId: emailAccountId,
            provider: mailProvider,
          });
          return;
        }
        if (
          message.type !== "owner" ||
          message.accountId !== emailAccountId ||
          engine ||
          published
        ) {
          return;
        }
        const follower = createTabFollowerClient({
          accountId: emailAccountId,
          provider: mailProvider,
          bus,
        });
        publishClient(
          follower,
          "follower",
          "browser",
          follower.ensureAccount,
        ).catch(fail);
      });
      bus.post({
        type: "hello",
        accountId: emailAccountId,
        provider: mailProvider,
      });
    }

    async function start() {
      stage = "owner-lock";
      const create = async () => {
        stage = "browser-start";
        engine = await createBrowserMailEngine({
          accountId: emailAccountId,
          provider: mailProvider,
          online: typeof navigator === "undefined" || navigator.onLine,
        });
        if (abort.signal.aborted) {
          return;
        }
        if (bus) {
          unbindOwner = bindTabMailOwner({
            client: engine,
            bus,
            ensureAccount: engine.ensureAccount,
          });
          bus.post({ type: "ready" });
        }
        await publishClient(engine, "owner", "browser", engine.ensureAccount);
      };
      await holdMailEngineOwner({
        signal: abort.signal,
        start: create,
        close: async () => {
          unbindOwner?.();
          await engine?.close().catch(() => undefined);
        },
      });
    }

    start().catch(fail);

    const unsubscribeLogout = subscribeMailEngineLogout(() => {
      abort.abort();
    });

    return () => {
      unsubscribeLogout();
      unsubscribeAccounts?.();
      abort.abort();
      unbindOwner?.();
      unbindHello?.();
      if (published) disposeTabFollowerClient(published);
      clearMailEngineInspect();
      setActiveMailClient(null);
      channel?.close();
      setClient(null);
    };
  }, [
    emailAccountId,
    provider,
    enabled,
    desktopIpc,
    requestBrowserEngine,
    attempt,
  ]);

  useEffect(() => {
    // The desktop engine follows mailbox changes itself.
    if (!client || !emailAccountId || hasDesktopMailEngineIpc()) return;
    return followMailboxChanges({
      accountId: emailAccountId,
      onChange: () => {
        client.requestSync([emailAccountId]).catch(() => undefined);
      },
    });
  }, [client, emailAccountId]);

  useEffect(() => {
    if (!client || !emailAccountId) return;
    const resumeDeferred = () => {
      if (!navigator.onLine) return;
      client.requestSync([emailAccountId]).catch(() => undefined);
    };
    window.addEventListener("online", resumeDeferred);
    return () => window.removeEventListener("online", resumeDeferred);
  }, [client, emailAccountId]);

  return (
    <MailEngineRuntimeStatusContext.Provider
      value={{ client, mounted: true, failed, retry, requestBrowserEngine }}
    >
      <MailEngineProvider client={client}>{children}</MailEngineProvider>
    </MailEngineRuntimeStatusContext.Provider>
  );
}

function publishMailEngineInspect(
  client: MailClient,
  accountId: string,
  role: "owner" | "follower",
  transport: MailEngineInspectTransport,
) {
  if (!canExposeMailEngineInspect()) return;
  window.__inboxZeroMailInspect = {
    accountId,
    role,
    transport,
    capabilities: browserMailEngineCapabilities(),
    read: () => client.getDiagnostics(accountId),
    requestSync: () => client.requestSync([accountId]),
    inspect: () =>
      "inspect" in client && typeof client.inspect === "function"
        ? (
            client as MailClient & {
              inspect: () => Promise<unknown>;
            }
          ).inspect()
        : Promise.resolve(null),
  };
}

function clearMailEngineInspect() {
  if (typeof window === "undefined") return;
  window.__inboxZeroMailInspect = undefined;
}

function canExposeMailEngineInspect() {
  return (
    typeof window !== "undefined" &&
    (process.env.NODE_ENV !== "production" ||
      env.NEXT_PUBLIC_MAIL_ENGINE_TEST_INSPECT)
  );
}

function subscribeNever() {
  return () => undefined;
}

declare global {
  interface Window {
    __inboxZeroMailInspect?: {
      accountId: string;
      role: "owner" | "follower";
      transport: MailEngineInspectTransport;
      capabilities: ReturnType<typeof browserMailEngineCapabilities>;
      read: () => Promise<unknown>;
      requestSync: () => Promise<unknown>;
      inspect: () => Promise<unknown>;
    };
  }
}
