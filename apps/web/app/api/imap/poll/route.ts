import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";
import { imapPollBody, pollImapAccount } from "@/utils/imap/poll";

export const maxDuration = 300;

export const POST = withError(
  "imap/poll",
  withQstashOrInternal(async (request) => {
    const parsed = imapPollBody.safeParse(await request.json());
    if (!parsed.success)
      return new Response("Invalid payload", { status: 400 });
    const emailAccountId = parsed.data.emailAccountId;
    return NextResponse.json(
      await pollImapAccount(
        emailAccountId,
        request.logger.with({ emailAccountId }),
      ),
    );
  }),
);
