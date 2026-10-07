import { createForwardingQueueHandler } from "@/utils/queue/create-forwarding-queue-handler";
import { imapPollBody } from "@/utils/imap/poll";

export const maxDuration = 300;

export const POST = createForwardingQueueHandler({
  loggerScope: "imap/poll/queue",
  schema: imapPollBody,
  path: "/api/imap/poll",
  invalidPayloadMessage: "Invalid IMAP polling payload",
  visibilityTimeoutSeconds: 330,
  getLoggerContext: (payload) => ({ emailAccountId: payload.emailAccountId }),
});
