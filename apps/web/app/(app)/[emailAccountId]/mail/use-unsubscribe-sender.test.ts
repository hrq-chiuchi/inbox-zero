// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsubscribeSender } from "./use-unsubscribe-sender";

const {
  unsubscribeSenderMock,
  setSenderStatusMock,
  queueArchiveSendersMock,
  decrementCreditMock,
} = vi.hoisted(() => ({
  unsubscribeSenderMock: vi.fn(),
  setSenderStatusMock: vi.fn(),
  queueArchiveSendersMock: vi.fn(),
  decrementCreditMock: vi.fn(),
}));

vi.mock("swr", () => ({
  default: () => ({ data: undefined, isLoading: false, mutate: vi.fn() }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "hostinger-account", provider: "imap" }),
}));
vi.mock("@/hooks/usePremium", () => ({
  usePremium: () => ({ hasUnsubscribeAccess: true, mutate: vi.fn() }),
}));
vi.mock("@/app/(app)/premium/PremiumModal", () => ({
  usePremiumModal: () => ({ PremiumModal: vi.fn(), openModal: vi.fn() }),
}));
vi.mock("@/store/archive-sender-queue", () => ({
  useArchiveSenderQueueActions: () => ({
    queueArchiveSenders: queueArchiveSendersMock,
  }),
}));
vi.mock("@/utils/actions/unsubscriber", () => ({
  setSenderStatusAction: setSenderStatusMock,
  unsubscribeSenderAction: unsubscribeSenderMock,
}));
vi.mock("@/utils/actions/premium", () => ({
  decrementUnsubscribeCreditAction: decrementCreditMock,
}));
vi.mock("sonner", () => ({
  toast: { loading: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

function getMessage(unsubscribeLink = "") {
  return {
    threadId: "thread-1",
    headers: {
      from: "Newsletter <news@example.com>",
      date: "Mon, 5 Oct 2026 10:00:00 +0000",
      subject: "Newsletter",
      to: "fixture@example.test",
      "list-unsubscribe": unsubscribeLink,
    },
  };
}

describe("Hostinger mail sender commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queueArchiveSendersMock.mockResolvedValue(1);
    decrementCreditMock.mockResolvedValue(undefined);
    unsubscribeSenderMock.mockResolvedValue({
      data: { unsubscribe: { success: true } },
    });
  });

  it("does not block a sender without an unsubscribe link or enable native filters", async () => {
    const { result } = renderHook(() => useUnsubscribeSender(getMessage()));

    expect(result.current.canManageAutoArchive).toBe(false);
    expect(result.current.isUnsubscribeDisabled).toBe(true);
    await act(async () => {
      await result.current.onUnsubscribe();
      await result.current.onToggleAutoArchive();
    });

    expect(setSenderStatusMock).not.toHaveBeenCalled();
    expect(unsubscribeSenderMock).not.toHaveBeenCalled();
    expect(queueArchiveSendersMock).not.toHaveBeenCalled();
    expect(decrementCreditMock).not.toHaveBeenCalled();
  });

  it("keeps real unsubscribe commands available independently of native filters", async () => {
    const { result } = renderHook(() =>
      useUnsubscribeSender(getMessage("<https://example.com/unsubscribe>")),
    );

    expect(result.current.canManageSenderActions).toBe(true);
    expect(result.current.canManageAutoArchive).toBe(false);
    expect(result.current.isUnsubscribeDisabled).toBe(false);
    await act(async () => result.current.onUnsubscribe());

    expect(unsubscribeSenderMock).toHaveBeenCalled();
    expect(queueArchiveSendersMock).toHaveBeenCalled();
    expect(setSenderStatusMock).not.toHaveBeenCalled();
  });

  it("opens manual unsubscribe links without claiming a block or metering it", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const { result } = renderHook(() =>
      useUnsubscribeSender(getMessage("<mailto:leave@example.com>")),
    );

    await act(async () => result.current.onUnsubscribe());

    expect(open).toHaveBeenCalledWith(
      "mailto:leave@example.com",
      "_blank",
      "noopener,noreferrer",
    );
    expect(setSenderStatusMock).not.toHaveBeenCalled();
    expect(unsubscribeSenderMock).not.toHaveBeenCalled();
    expect(decrementCreditMock).not.toHaveBeenCalled();
    open.mockRestore();
  });
});
