"use server";

import {
  setSenderStatusBody,
  unsubscribeSenderBody,
} from "@/utils/actions/unsubscriber.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { createEmailProvider } from "@/utils/email/provider";
import {
  setSenderStatusWithAutoArchive,
  setSenderStatus,
  unsubscribeSenderAndMark,
} from "@/utils/senders/unsubscribe";
import { NewsletterStatus } from "@/generated/prisma/enums";
import { isImapProvider } from "@/utils/email/provider-types";
import { SafeError } from "@/utils/error";

export const setSenderStatusAction = actionClient
  .metadata({ name: "setSenderStatus" })
  .inputSchema(setSenderStatusBody)
  .action(
    async ({
      parsedInput: { senderEmail, status, labelId, labelName },
      ctx: { emailAccountId, provider, logger },
    }) => {
      if (isImapProvider(provider)) {
        if (status === NewsletterStatus.AUTO_ARCHIVED || labelId || labelName) {
          throw new SafeError(
            "Hostinger does not support automatic archive, sender blocking, or filters for future emails. You can archive existing emails or use a sender's unsubscribe link.",
          );
        }
        const sender = await setSenderStatus({
          emailAccountId,
          senderEmail,
          status,
        });
        return { senderEmail: sender.email, status, autoArchived: false };
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      return setSenderStatusWithAutoArchive({
        emailAccountId,
        emailProvider,
        senderEmail,
        status,
        labelId,
        labelName,
      });
    },
  );

export const unsubscribeSenderAction = actionClient
  .metadata({ name: "unsubscribeSender" })
  .inputSchema(unsubscribeSenderBody)
  .action(
    async ({
      parsedInput: { senderEmail, unsubscribeLink, listUnsubscribeHeader },
      ctx: { emailAccountId, logger },
    }) =>
      unsubscribeSenderAndMark({
        emailAccountId,
        senderEmail,
        unsubscribeLink,
        listUnsubscribeHeader,
        logger,
      }),
  );
