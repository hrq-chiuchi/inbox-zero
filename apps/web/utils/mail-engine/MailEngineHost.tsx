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
import { usePathname } from "next/navigation";
import type { MailClient, WorkAdmission } from "@inboxzero/mail-core/engine";
import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";
import { LoadingContent } from "@/components/LoadingContent";
import { env } from "@/env";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  createBrowserMailEngine,
  type BrowserMailEngine,
} from "@/utils/mail-engine/create-browser-engine";
import {
  createDesktopIpcMailClient,
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
  MAIL_ENGINE_OWNER_LOCK,
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
  unavailable: boolean;
  requestBrowserEngine: () => void;
};

type MailEngineInspectTransport = "browser" | "desktop-ipc";

const MailEngineRuntimeStatusContext = createContext<MailEngineRuntimeStatus>({
  client: null,
  mounted: false,
  unavailable: false,
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
    opfs: browserMailEngineCapabilities().opfs,
  });
  if (status.unavailable || mode === "unavailable") {
    return (
      <div className="flex flex-1 items-center justify-center p-6 text-muted-foreground text-sm">
        Mail needs persistent browser storage.
      </div>
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
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (!emailAccountId || !enabled) {
      setUnavailable(false);
      return;
    }
    // Keep queued sends and undo working after the initiating page or composer closes.
    if (!desktopIpc) requestBrowserEngine();
    setUnavailable(false);
    const mode = selectMailEngineRuntimeMode({
      desktopIpc,
      opfs: browserMailEngineCapabilities().opfs,
    });
    if (mode === "unavailable") {
      setUnavailable(true);
      return;
    }
    const parsedProvider = providerSchema.safeParse(provider);
    if (!parsedProvider.success) {
      setUnavailable(true);
      return;
    }
    const mailProvider = parsedProvider.data;
    const abort = new AbortController();
    let published: MailClient | undefined;
    let unsubscribeAccounts: (() => void) | undefined;

    async function publishClient(
      next: MailClient,
      role: "owner" | "follower",
      transport: MailEngineInspectTransport,
      ensureAccount: (account: {
        accountId: string;
        provider: Provider;
      }) => Promise<void>,
    ) {
      if (abort.signal.aborted) return;
      if (published && published !== next) disposeTabFollowerClient(published);
      published = next;
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
      publishMailEngineInspect(next, emailAccountId, role, transport);
      setActiveMailClient(next);
      setClient(next);
    }

    if (mode === "desktop-ipc") {
      const client = createDesktopIpcMailClient({ provider: mailProvider });
      const providers = new Map<string, Provider>([
        [emailAccountId, mailProvider],
      ]);
      const providerClients = new Map<Provider, MailClient>([
        [mailProvider, { ...client }],
      ]);
      const clientForProvider = (accountProvider: Provider) => {
        let providerClient = providerClients.get(accountProvider);
        if (!providerClient) {
          providerClient = createDesktopIpcMailClient({
            provider: accountProvider,
          });
          providerClients.set(accountProvider, providerClient);
        }
        return providerClient;
      };
      client.requestSync = async (accountIds): Promise<WorkAdmission> => {
        const grouped = new Map<Provider, string[]>();
        for (const accountId of accountIds) {
          const accountProvider = providers.get(accountId) ?? mailProvider;
          const ids = grouped.get(accountProvider) ?? [];
          ids.push(accountId);
          grouped.set(accountProvider, ids);
        }
        const admissions = await Promise.all(
          [...grouped].map(([accountProvider, ids]) =>
            clientForProvider(accountProvider).requestSync(ids),
          ),
        );
        return (
          admissions.find((admission) => admission.status === "rejected") ??
          admissions[0] ?? { status: "already_satisfied" }
        );
      };
      publishClient(client, "owner", "desktop-ipc", async (account) => {
        // The installed main process registers through requestSync's provider.
        providers.set(account.accountId, account.provider);
        await clientForProvider(account.provider).requestSync([
          account.accountId,
        ]);
      }).catch(() => {
        if (!abort.signal.aborted) setUnavailable(true);
      });
      client.requestSync([emailAccountId]).catch(() => undefined);
      const unsubscribeLogout = subscribeMailEngineLogout(() => abort.abort());
      return () => {
        unsubscribeLogout();
        unsubscribeAccounts?.();
        abort.abort();
        for (const providerClient of providerClients.values()) {
          providerClient.close?.().catch(() => undefined);
        }
        if (published) disposeTabFollowerClient(published);
        clearMailEngineInspect();
        setActiveMailClient(null);
        setClient(null);
      };
    }

    let engine: BrowserMailEngine | undefined;
    let unbindOwner: (() => void) | undefined;
    let unbindHello: (() => void) | undefined;
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(MAIL_ENGINE_TAB_CHANNEL)
        : null;
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
        ).catch(() => undefined);
      });
      bus.post({
        type: "hello",
        accountId: emailAccountId,
        provider: mailProvider,
      });
    }

    async function hold(create: () => Promise<void>) {
      await create();
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }

    async function start() {
      const create = async () => {
        engine = await createBrowserMailEngine({
          accountId: emailAccountId,
          provider: mailProvider,
          online: typeof navigator === "undefined" || navigator.onLine,
        });
        if (abort.signal.aborted) {
          await engine.close();
          return;
        }
        if (bus) {
          unbindOwner = bindTabMailOwner({
            client: engine,
            bus,
            ensureAccount: engine.ensureAccount,
          });
          bus.post({ type: "ready" });
          bus.post({ type: "owner", accountId: emailAccountId });
        }
        await publishClient(engine, "owner", "browser", engine.ensureAccount);
      };
      if (typeof navigator !== "undefined" && navigator.locks?.request) {
        await navigator.locks.request(
          MAIL_ENGINE_OWNER_LOCK,
          { signal: abort.signal },
          () => hold(create),
        );
        return;
      }
      await hold(create);
    }

    start().catch(() => {
      if (!abort.signal.aborted) setUnavailable(true);
    });

    const unsubscribeLogout = subscribeMailEngineLogout(() => {
      abort.abort();
      engine?.close().catch(() => undefined);
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
      engine?.close().catch(() => undefined);
      setClient(null);
    };
  }, [emailAccountId, provider, enabled, desktopIpc, requestBrowserEngine]);

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
      value={{ client, mounted: true, unavailable, requestBrowserEngine }}
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
