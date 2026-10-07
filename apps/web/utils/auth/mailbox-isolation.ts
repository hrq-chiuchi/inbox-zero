import prisma from "@/utils/prisma";

// IMAP rows share the mailbox's Account relation, but never confer login
// authority or count toward Better Auth's last-login-account protection.
export const authOnlyPrisma = prisma.$extends({
  query: {
    account: {
      findMany({ args, query }) {
        args.where = { AND: [args.where ?? {}, { provider: { not: "imap" } }] };
        return query(args);
      },
      findFirst({ args, query }) {
        args.where = { AND: [args.where ?? {}, { provider: { not: "imap" } }] };
        return query(args);
      },
      count({ args, query }) {
        args.where = { AND: [args.where ?? {}, { provider: { not: "imap" } }] };
        return query(args);
      },
    },
  },
});
