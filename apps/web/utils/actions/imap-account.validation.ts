import { z } from "zod";

export const connectHostingerAccountBody = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter a valid mailbox email address"),
  password: z
    .string()
    .min(1, "Enter your mailbox password")
    .max(1024, "Password is too long"),
  name: z.string().trim().max(200, "Name is too long").optional(),
  smtpPort: z.union([z.literal(465), z.literal(587)]),
  emailAccountId: z.string().min(1).optional(),
});

export type ConnectHostingerAccountBody = z.infer<
  typeof connectHostingerAccountBody
>;
