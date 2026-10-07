"use client";

import { useId, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useAction } from "next-safe-action/hooks";
import { useRouter } from "next/navigation";
import { MailIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/Input";
import { Label } from "@/components/ui/label";
import { toastSuccess } from "@/components/Toast";
import { useAccounts } from "@/hooks/useAccounts";
import { getActionErrorMessage } from "@/utils/error";
import { connectHostingerAccountAction } from "@/utils/actions/imap-account";
import { connectHostingerAccountBody } from "@/utils/actions/imap-account.validation";
import type { ConnectHostingerAccountBody } from "@/utils/actions/imap-account.validation";

export function HostingerAccountForm({
  account,
  onCancel,
  onConnected,
}: {
  account?: { id: string; email: string; name: string | null };
  onCancel?: () => void;
  onConnected?: () => void;
}) {
  const id = useId();
  const router = useRouter();
  const { mutate } = useAccounts();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const {
    register,
    handleSubmit,
    setValue,
    resetField,
    formState: { errors },
  } = useForm<ConnectHostingerAccountBody>({
    resolver: zodResolver(connectHostingerAccountBody),
    defaultValues: {
      email: account?.email ?? "",
      name: account?.name ?? "",
      password: "",
      smtpPort: 465,
      emailAccountId: account?.id,
    },
  });
  const { execute, isExecuting } = useAction(connectHostingerAccountAction, {
    onSuccess: ({ data }) => {
      if (!data?.emailAccountId) return;
      setConnected(true);
      toastSuccess({
        title: account ? "Hostinger reconnected" : "Hostinger connected",
        description: "Your mailbox is ready to sync.",
      });
      router.refresh();
      onConnected?.();
    },
    onError: ({ error }) => {
      setErrorMessage(
        getActionErrorMessage(error) ??
          "Could not connect Hostinger. Please try again.",
      );
    },
    onSettled: () => {
      resetField("password");
      mutate();
    },
  });

  if (connected) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Hostinger {account ? "reconnected" : "connected"}. Your mailbox is ready
        to sync.
      </p>
    );
  }

  return (
    <form
      className="w-full space-y-4 text-left"
      onSubmit={handleSubmit((data) => {
        setErrorMessage(null);
        execute(data);
        resetField("password");
      })}
      aria-busy={isExecuting}
    >
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          <MailIcon className="size-4" />
          {account ? "Reconnect Hostinger" : "Connect Hostinger"}
        </h3>
        <p className="text-sm text-muted-foreground">
          Use your Hostinger mailbox password, not your hosting account
          password. This adds a mailbox, not a new sign-in method.
        </p>
      </div>
      <fieldset disabled={isExecuting} className="space-y-4">
        <Input
          name={`${id}-email`}
          label="Mailbox email"
          type="email"
          error={errors.email}
          registerProps={{
            ...register("email"),
            id: `${id}-email`,
            autoComplete: "email",
            readOnly: !!account,
          }}
        />
        <Input
          name={`${id}-password`}
          label="Mailbox password"
          type="password"
          error={errors.password}
          registerProps={{
            ...register("password"),
            id: `${id}-password`,
            autoComplete: "new-password",
          }}
        />
        <Input
          name={`${id}-name`}
          label="Sender name (optional)"
          type="text"
          error={errors.name}
          registerProps={{
            ...register("name"),
            id: `${id}-name`,
            autoComplete: "name",
          }}
        />
        <div className="space-y-1">
          <Label htmlFor={`${id}-smtp-port`}>SMTP security</Label>
          <select
            id={`${id}-smtp-port`}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            defaultValue="465"
            onChange={(event) =>
              setValue("smtpPort", event.target.value === "587" ? 587 : 465)
            }
          >
            <option value="465">Port 465 — TLS (recommended)</option>
            <option value="587">Port 587 — STARTTLS</option>
          </select>
        </div>
      </fieldset>
      <p className="text-xs text-muted-foreground">
        Incoming: imap.hostinger.com:993 (TLS). Outgoing: smtp.hostinger.com.
        Both connections are verified before your password is stored encrypted.
      </p>
      {errorMessage && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={isExecuting} disabled={isExecuting}>
          {isExecuting
            ? "Verifying connections…"
            : account
              ? "Verify and reconnect"
              : "Verify and connect"}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={isExecuting}
          >
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
