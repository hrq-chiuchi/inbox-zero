import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { enqueueImapPolling } from "@/utils/imap/poll";

export const maxDuration = 300;

export const GET = withError("cron/imap-poll", async (request) => {
  if (!hasCronSecret(request))
    return new Response("Unauthorized", { status: 401 });
  return NextResponse.json(await enqueueImapPolling(request.logger));
});

export const POST = withError("cron/imap-poll", async (request) => {
  if (!(await hasPostCronSecret(request)))
    return new Response("Unauthorized", { status: 401 });
  return NextResponse.json(await enqueueImapPolling(request.logger));
});
