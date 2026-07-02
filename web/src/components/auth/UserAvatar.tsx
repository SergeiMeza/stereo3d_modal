/**
 * Avatar shared by the header menu and the account screen: the provider
 * photo when there is one, otherwise an initial-letter block. Plain <img>
 * on purpose — provider photo hosts (googleusercontent etc.) would each
 * need next/image remotePatterns entries for a 24px avatar.
 */

import { cn } from "@/lib/utils";

export function UserAvatar({
  photoURL,
  name,
  className,
}: {
  photoURL: string | null;
  name: string | null;
  className?: string;
}) {
  const initial = (name ?? "?").trim().charAt(0).toUpperCase() || "?";
  if (photoURL !== null) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={photoURL}
        alt=""
        referrerPolicy="no-referrer"
        className={cn("size-6 shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-xs font-semibold text-primary",
        className,
      )}
    >
      {initial}
    </span>
  );
}
