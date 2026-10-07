"use client";

import { useState } from "react";
import type { ReactNode } from "react";
import { MailIcon } from "lucide-react";
import { HostingerAccountForm } from "@/app/(app)/accounts/HostingerAccountForm";
import { Button } from "@/components/ui/button";
import { toastError } from "@/components/Toast";
import Image from "next/image";
import { MutedText } from "@/components/Typography";
import { getAccountLinkingUrl } from "@/utils/account-linking";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { redirectToSafeUrl } from "@/utils/redirect";

export function AddAccount({
  helperText = "You will be billed for each account.",
}: {
  helperText?: ReactNode;
}) {
  const [isLoadingGoogle, setIsLoadingGoogle] = useState(false);
  const [isLoadingMicrosoft, setIsLoadingMicrosoft] = useState(false);
  const [showHostinger, setShowHostinger] = useState(false);

  const handleAddAccount = async (provider: "google" | "microsoft") => {
    const setLoading = isGoogleProvider(provider)
      ? setIsLoadingGoogle
      : setIsLoadingMicrosoft;
    setLoading(true);

    try {
      const url = await getAccountLinkingUrl(provider);
      redirectToSafeUrl(url, { allowExternal: true });
    } catch (error) {
      console.error(`Error initiating ${provider} link:`, error);
      toastError({
        title: `Error initiating ${isGoogleProvider(provider) ? "Google" : "Microsoft"} link`,
        description:
          error instanceof Error
            ? error.message
            : "Please try again or contact support",
      });
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col items-center justify-center gap-3 min-h-[90px]">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => handleAddAccount("google")}
          loading={isLoadingGoogle}
          disabled={showHostinger || isLoadingGoogle || isLoadingMicrosoft}
        >
          <Image
            src="/images/google.svg"
            alt=""
            width={24}
            height={24}
            unoptimized
          />
          <span className="ml-2">Add Google</span>
        </Button>
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => handleAddAccount("microsoft")}
          loading={isLoadingMicrosoft}
          disabled={showHostinger || isLoadingGoogle || isLoadingMicrosoft}
        >
          <Image
            src="/images/microsoft.svg"
            alt=""
            width={24}
            height={24}
            unoptimized
          />
          <span className="ml-2">Add Microsoft</span>
        </Button>
        <Button
          variant="outline"
          className="w-full sm:w-auto"
          onClick={() => setShowHostinger(true)}
          disabled={showHostinger || isLoadingGoogle || isLoadingMicrosoft}
          aria-expanded={showHostinger}
        >
          <MailIcon className="size-5" />
          <span className="ml-2">Add Hostinger</span>
        </Button>
      </div>

      <MutedText>{helperText}</MutedText>
      {showHostinger && (
        <div className="w-full max-w-md rounded-md border p-4">
          <HostingerAccountForm
            onCancel={() => setShowHostinger(false)}
            onConnected={() => setShowHostinger(false)}
          />
        </div>
      )}
    </div>
  );
}
